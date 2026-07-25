import axios from "axios";

function isNumeric(value) {
  return /^-?\d+$/.test(value);
}

// Fetch bus timings from Citymapper backup API
async function fetchCMTimings(stopid, location) {
  if (!location) {
    throw new Error("Location parameter required for Citymapper lookup");
  }

  const nearbyUrl = `https://citymapper.com/api/3/nearby?brand_ids=SBSTBuses%2CSMRTBuses%2CTTSBuses%2CGASBuses%2CSentosaBus%2CSentosaTram%2CSingaporeShuttle&location=${encodeURIComponent(
    location
  )}&region_id=sg-singapore&extended=1`;

  const res1 = await axios.get(nearbyUrl, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });

  const elements = res1.data && res1.data.elements ? res1.data.elements : [];
  const matchedElement = elements.find(
    (el) => String(el.stop_code) === String(stopid)
  );

  if (!matchedElement) {
    throw new Error(`Stop code ${stopid} was not found nearby.`);
  }

  const cmStopId = matchedElement.id;

  const departuresUrl = `https://citymapper.com/api/1/departures?headways=1&ids=${encodeURIComponent(
    cmStopId
  )}&region_id=sg-singapore`;

  const res2 = await axios.get(departuresUrl, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });

  const stopData = res2.data && res2.data.stops && res2.data.stops[0];
  if (!stopData) {
    return {
      "odata.metadata":
        "http://datamall2.mytransport.sg/ltaodataservice/$metadata#BusArrivalv2/@Element",
      BusStopCode: stopid,
      Services: [],
    };
  }

  const routeMap = {};
  (stopData.routes || []).forEach((r) => {
    routeMap[r.id] = r;
  });

  const servicesMap = {};
  const now = Date.now();

  (stopData.services || []).forEach((s) => {
    const route = routeMap[s.route_id];
    const serviceNo = route ? route.name : s.route_id;
    const brand = route ? route.brand || "" : "";

    let operator = "SBST";
    if (brand.startsWith("GAS")) operator = "GAS";
    else if (brand.startsWith("SMRT")) operator = "SMRT";
    else if (brand.startsWith("TTS")) operator = "TTS";
    else if (brand.startsWith("SBST")) operator = "SBST";
    else if (brand) operator = brand.replace("Buses", "");

    if (!servicesMap[serviceNo]) {
      servicesMap[serviceNo] = {
        ServiceNo: serviceNo,
        Operator: operator,
        arrivals: [],
      };
    }

    if (Array.isArray(s.live_departures_seconds)) {
      s.live_departures_seconds.forEach((sec) => {
        servicesMap[serviceNo].arrivals.push(
          new Date(now + sec * 1000).toISOString()
        );
      });
    }
    if (Array.isArray(s.next_departures)) {
      s.next_departures.forEach((dep) => {
        servicesMap[serviceNo].arrivals.push(new Date(dep).toISOString());
      });
    }
  });

  const formattedServices = Object.values(servicesMap).map((srv) => {
    const sortedArrivals = Array.from(new Set(srv.arrivals)).sort(
      (a, b) => new Date(a) - new Date(b)
    );

    const createNextBusObj = (isoStr) => {
      if (!isoStr) {
        return {
          OriginCode: "",
          DestinationCode: "",
          EstimatedArrival: "",
          Latitude: "0",
          Longitude: "0",
          VisitNumber: "",
          Load: "",
          Feature: "",
          Type: "",
        };
      }
      return {
        OriginCode: "",
        DestinationCode: "",
        EstimatedArrival: isoStr,
        Latitude: "0",
        Longitude: "0",
        VisitNumber: "1",
        Load: "",
        Feature: "",
        Type: "",
      };
    };

    return {
      ServiceNo: srv.ServiceNo,
      Operator: srv.Operator,
      NextBus: createNextBusObj(sortedArrivals[0]),
      NextBus2: createNextBusObj(sortedArrivals[1]),
      NextBus3: createNextBusObj(sortedArrivals[2]),
    };
  });

  formattedServices.sort((a, b) => {
    const aNum = isNumeric(a.ServiceNo);
    const bNum = isNumeric(b.ServiceNo);
    if (aNum && bNum) {
      return Number(a.ServiceNo) - Number(b.ServiceNo);
    } else if (aNum) {
      return -1;
    } else if (bNum) {
      return 1;
    } else {
      return a.ServiceNo.localeCompare(b.ServiceNo, undefined, {
        numeric: true,
      });
    }
  });

  return {
    "odata.metadata":
      "http://datamall2.mytransport.sg/ltaodataservice/$metadata#BusArrivalv2/@Element",
    BusStopCode: stopid,
    Services: formattedServices,
    CM: true,
  };
}

export default async function handler(req, res) {
  const { stopid } = req.query;

  let location = req.query.location;
  if (!location) {
    const lat = req.query.lat || req.query.latitude;
    const lng = req.query.lng || req.query.long || req.query.longitude || req.query.lon;
    if (lat && lng) {
      location = `${lat},${lng}`;
    }
  }

  // Expected buses sent by client
  let expectedBuses = [];
  const rawBuses = req.query.buses || req.query.expectedBuses;
  if (rawBuses) {
    if (Array.isArray(rawBuses)) {
      expectedBuses = rawBuses;
    } else {
      expectedBuses = String(rawBuses)
        .split(",")
        .map((b) => b.trim())
        .filter(Boolean);
    }
  }

  let ltaData = null;
  let useCMFallback = false;

  // 1. Try fetching timings from LTA
  try {
    const ltaResp = await axios.get(
      `https://datamall2.mytransport.sg/ltaodataservice/v3/BusArrival?BusStopCode=${stopid}`,
      {
        headers: {
          AccountKey: process.env.ACCKEY,
        },
        timeout: 5000,
      }
    );

    ltaData = ltaResp.data;

    if (!ltaData || !Array.isArray(ltaData.Services) || ltaData.Services.length === 0) {
      useCMFallback = true;
    } else {
      const services = ltaData.Services;

      if (expectedBuses.length > 0) {
        const totalExpected = expectedBuses.length;
        const expectedSet = new Set(expectedBuses.map(String));

        let busesWithTimingsCount = 0;
        services.forEach((s) => {
          if (
            expectedSet.has(String(s.ServiceNo)) &&
            s.NextBus &&
            s.NextBus.EstimatedArrival
          ) {
            busesWithTimingsCount++;
          }
        });

        if (totalExpected < 4) {
          // Less than 4 buses at stop: if LTA has timings for even 1 bus, ignore CM
          if (busesWithTimingsCount === 0) {
            useCMFallback = true;
          }
        } else {
          // 4 or more buses at stop: if < 50% have timings, fetch from CM
          if (busesWithTimingsCount / totalExpected < 0.5) {
            useCMFallback = true;
          }
        }
      } else {
        // Fallback check if client did not pass expected buses list
        const totalServices = services.length;
        let busesWithTimingsCount = 0;
        services.forEach((s) => {
          if (s.NextBus && s.NextBus.EstimatedArrival) {
            busesWithTimingsCount++;
          }
        });

        if (totalServices < 4) {
          if (busesWithTimingsCount === 0) {
            useCMFallback = true;
          }
        } else {
          if (busesWithTimingsCount / totalServices < 0.5) {
            useCMFallback = true;
          }
        }
      }
    }
  } catch (e) {
    useCMFallback = true;
  }

  // 2. Fallback to CM if triggered
  if (useCMFallback) {
    try {
      console.log(`[CM Timings] Using Citymapper timings for stop ${stopid}`);
      const cmData = await fetchCMTimings(stopid, location);
      res.setHeader("Cache-Control", "s-maxage=30");
      return res.status(200).json(cmData);
    } catch (cmErr) {
      if (ltaData && Array.isArray(ltaData.Services) && ltaData.Services.length > 0) {
        ltaData.Services.sort((a, b) => {
          if (isNumeric(a.ServiceNo) && isNumeric(b.ServiceNo)) {
            return Number(a.ServiceNo) - Number(b.ServiceNo);
          } else {
            return String(a.ServiceNo).localeCompare(String(b.ServiceNo), undefined, {
              numeric: true,
            });
          }
        });
        res.setHeader("Cache-Control", "s-maxage=30");
        return res.status(200).json(ltaData);
      }

      res.setHeader("Content-Type", "text/plain");
      return res
        .status(500)
        .end("Failed to fetch bus timings from both LTA and Citymapper.");
    }
  }

  ltaData.Services.sort((a, b) => {
    if (isNumeric(a.ServiceNo) && isNumeric(b.ServiceNo)) {
      return Number(a.ServiceNo) - Number(b.ServiceNo);
    } else {
      return String(a.ServiceNo).localeCompare(String(b.ServiceNo), undefined, {
        numeric: true,
      });
    }
  });

  res.setHeader("Cache-Control", "s-maxage=30");
  return res.status(200).json(ltaData);
}
