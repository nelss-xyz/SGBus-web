import axios from "axios";

function isNumeric(value) {
  return /^-?\d+$/.test(value);
}

// Helper to fetch bus timings from Citymapper
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
    console.error("CM fetch error in cmbd endpoint:", e.message);
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

  // Fetch from both LTA and CM concurrently
  const [ltaResult, cmResult] = await Promise.allSettled([
    axios.get(
      `https://datamall2.mytransport.sg/ltaodataservice/v3/BusArrival?BusStopCode=${stopid}`,
      {
        headers: {
          AccountKey: process.env.ACCKEY,
        },
        timeout: 5000,
      }
    ),
    fetchCMTimings(stopid, location),
  ]);

  // Parse LTA services
  const ltaServices =
    ltaResult.status === "fulfilled" &&
    ltaResult.value?.data &&
    Array.isArray(ltaResult.value.data.Services)
      ? ltaResult.value.data.Services
      : [];

  // Parse CM services
  const cmServices =
    cmResult.status === "fulfilled" && Array.isArray(cmResult.value)
      ? cmResult.value
      : [];

  const ltaMap = {};
  ltaServices.forEach((s) => {
    ltaMap[String(s.ServiceNo)] = s;
  });

  const cmMap = {};
  cmServices.forEach((s) => {
    cmMap[String(s.ServiceNo)] = s;
  });

  // Collect all unique service numbers
  const allServiceNos = Array.from(
    new Set([...Object.keys(ltaMap), ...Object.keys(cmMap)])
  );

  const mergedServices = [];
  const cmBusesUsed = [];

  const hasValidArrival = (serviceObj) => {
    return (
      serviceObj &&
      serviceObj.NextBus &&
      typeof serviceObj.NextBus.EstimatedArrival === "string" &&
      serviceObj.NextBus.EstimatedArrival.trim() !== ""
    );
  };

  allServiceNos.forEach((sNo) => {
    const ltaSvc = ltaMap[sNo];
    const cmSvc = cmMap[sNo];

    if (hasValidArrival(ltaSvc)) {
      // LTA data is available for this bus -> use LTA
      mergedServices.push(ltaSvc);
    } else if (hasValidArrival(cmSvc)) {
      // LTA data is not available, but CM data is -> use CM
      mergedServices.push(cmSvc);
      cmBusesUsed.push(sNo);
    } else if (ltaSvc) {
      // Fallback to LTA object if neither has valid timing
      mergedServices.push(ltaSvc);
    } else if (cmSvc) {
      // Fallback to CM object
      mergedServices.push(cmSvc);
      cmBusesUsed.push(sNo);
    }
  });

  if (cmBusesUsed.length > 0) {
    console.log(
      `[CMBD Timings] Used CM data for bus service(s) [${cmBusesUsed.join(
        ", "
      )}] at stop ${stopid}`
    );
  }

  // Sort services
  mergedServices.sort((a, b) => {
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
    Services: mergedServices,
  });
}
