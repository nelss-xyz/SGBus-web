import axios from "axios";

function isNumeric(value) {
  return /^-?\d+$/.test(value);
}

// Fetch bus timings from Citymapper backup API
async function fetchCMTimings(stopid, location) {
  if (!location) {
    return null;
  }

  try {
    const nearbyUrl = `https://citymapper.com/api/3/nearby?brand_ids=SBSTBuses%2CSMRTBuses%2CTTSBuses%2CGASBuses%2CSentosaBus%2CSentosaTram%2CSingaporeShuttle&location=${encodeURIComponent(
      location
    )}&region_id=sg-singapore&extended=1`;

    const res1 = await axios.get(nearbyUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 5000,
    });

    const elements = res1.data && res1.data.elements ? res1.data.elements : [];
    const matchedElement = elements.find(
      (el) => String(el.stop_code) === String(stopid)
    );

    if (!matchedElement) {
      return null;
    }

    const cmStopId = matchedElement.id;

    const departuresUrl = `https://citymapper.com/api/1/departures?headways=1&ids=${encodeURIComponent(
      cmStopId
    )}&region_id=sg-singapore`;

    const res2 = await axios.get(departuresUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 5000,
    });

    const stopData = res2.data && res2.data.stops && res2.data.stops[0];
    if (!stopData) {
      return [];
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
        CM: true,
      };
    });

    return formattedServices;
  } catch (e) {
    console.error("CM fetch error in default endpoint:", e.message);
    return null;
  }
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

  const hasValidArrival = (nextBusObj) => {
    return (
      nextBusObj &&
      typeof nextBusObj.EstimatedArrival === "string" &&
      nextBusObj.EstimatedArrival.trim() !== ""
    );
  };

  let ltaData = null;
  let needCMQuery = false;

  // Step 1: Query LTA data first
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

    const services = (ltaData && Array.isArray(ltaData.Services)) ? ltaData.Services : [];

    if (services.length === 0 && expectedBuses.length === 0) {
      needCMQuery = true;
    } else if (expectedBuses.length > 0) {
      // Exclude buses with letters in their names (e.g. 34A, 10e, 68B, 991B) from threshold count
      const numericExpected = expectedBuses.filter((b) => /^\d+$/.test(String(b).trim()));
      const targetBuses = numericExpected.length > 0 ? numericExpected : expectedBuses;

      const totalExpected = targetBuses.length;
      const expectedSet = new Set(targetBuses.map(String));

      let busesWithTimingsCount = 0;
      services.forEach((s) => {
        if (expectedSet.has(String(s.ServiceNo)) && hasValidArrival(s.NextBus)) {
          busesWithTimingsCount++;
        }
      });

      // If less than 50% of expected numeric buses have LTA timings (i.e. >= 50% missing), query CM
      if (totalExpected > 0 && busesWithTimingsCount / totalExpected < 0.5) {
        needCMQuery = true;
      }
    } else {
      // Exclude buses with letters in their names from threshold count
      const numericServices = services.filter((s) => /^\d+$/.test(String(s.ServiceNo).trim()));
      const targetServices = numericServices.length > 0 ? numericServices : services;

      const totalServices = targetServices.length;
      let busesWithTimingsCount = 0;
      targetServices.forEach((s) => {
        if (hasValidArrival(s.NextBus)) {
          busesWithTimingsCount++;
        }
      });

      if (totalServices === 0 || busesWithTimingsCount / totalServices < 0.5) {
        needCMQuery = true;
      }
    }
  } catch (ltaErr) {
    needCMQuery = true;
  }

  // Step 2: If threshold is NOT met (LTA is sufficient), return LTA data directly without querying CM
  if (!needCMQuery && ltaData && Array.isArray(ltaData.Services)) {
    ltaData.Services.sort((a, b) => {
      const aNum = isNumeric(a.ServiceNo);
      const bNum = isNumeric(b.ServiceNo);
      if (aNum && bNum) {
        return Number(a.ServiceNo) - Number(b.ServiceNo);
      } else if (aNum) {
        return -1;
      } else if (bNum) {
        return 1;
      } else {
        return String(a.ServiceNo).localeCompare(String(b.ServiceNo), undefined, {
          numeric: true,
        });
      }
    });

    res.setHeader("Cache-Control", "s-maxage=30");
    return res.status(200).json(ltaData);
  }

  // Step 3: Otherwise (>= 50% numeric bus data missing or LTA failed), THEN query CM
  const cmServices = (await fetchCMTimings(stopid, location)) || [];

  const ltaServices = (ltaData && Array.isArray(ltaData.Services)) ? ltaData.Services : [];

  const ltaMap = {};
  ltaServices.forEach((s) => {
    ltaMap[String(s.ServiceNo)] = s;
  });

  const cmMap = {};
  cmServices.forEach((s) => {
    cmMap[String(s.ServiceNo)] = s;
  });

  const allServiceNos = Array.from(
    new Set([
      ...expectedBuses.map(String),
      ...Object.keys(ltaMap),
      ...Object.keys(cmMap),
    ])
  );

  const fusedServices = [];
  const cmBusesUsed = [];

  allServiceNos.forEach((sNo) => {
    const ltaSvc = ltaMap[sNo];
    const cmSvc = cmMap[sNo];

    if (ltaSvc && hasValidArrival(ltaSvc.NextBus)) {
      const mergedSvc = { ...ltaSvc };
      let filledGap = false;

      if (
        !hasValidArrival(mergedSvc.NextBus2) &&
        cmSvc &&
        hasValidArrival(cmSvc.NextBus2)
      ) {
        mergedSvc.NextBus2 = cmSvc.NextBus2;
        filledGap = true;
      }

      if (
        !hasValidArrival(mergedSvc.NextBus3) &&
        cmSvc &&
        hasValidArrival(cmSvc.NextBus3)
      ) {
        mergedSvc.NextBus3 = cmSvc.NextBus3;
        filledGap = true;
      }

      if (filledGap) {
        mergedSvc.CM = true;
        cmBusesUsed.push(sNo);
      }

      fusedServices.push(mergedSvc);
    } else if (cmSvc && hasValidArrival(cmSvc.NextBus)) {
      const mergedSvc = { ...cmSvc, CM: true };
      cmBusesUsed.push(sNo);
      fusedServices.push(mergedSvc);
    } else if (ltaSvc) {
      fusedServices.push(ltaSvc);
    } else if (cmSvc) {
      const mergedSvc = { ...cmSvc, CM: true };
      cmBusesUsed.push(sNo);
      fusedServices.push(mergedSvc);
    }
  });

  if (cmBusesUsed.length > 0) {
    console.log(
      `[Default Timings] Fused CM data for bus service(s) [${cmBusesUsed.join(
        ", "
      )}] at stop ${stopid}`
    );
  }

  fusedServices.sort((a, b) => {
    const aNum = isNumeric(a.ServiceNo);
    const bNum = isNumeric(b.ServiceNo);
    if (aNum && bNum) {
      return Number(a.ServiceNo) - Number(b.ServiceNo);
    } else if (aNum) {
      return -1;
    } else if (bNum) {
      return 1;
    } else {
      return String(a.ServiceNo).localeCompare(String(b.ServiceNo), undefined, {
        numeric: true,
      });
    }
  });

  res.setHeader("Cache-Control", "s-maxage=30");
  return res.status(200).json({
    "odata.metadata":
      "http://datamall2.mytransport.sg/ltaodataservice/$metadata#BusArrivalv2/@Element",
    BusStopCode: stopid,
    Services: fusedServices,
  });
}
