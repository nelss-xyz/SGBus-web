import axios from "axios";

function isNumeric(value) {
  return /^-?\d+$/.test(value);
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

  if (!stopid || !location) {
    res.setHeader("Content-Type", "text/plain");
    return res
      .status(400)
      .end("Missing required parameters: stopid and location coordinates (e.g. ?location=lat,lng or ?lat=...&lng=...).");
  }

  try {
    // 1. Fetch nearby stops from Citymapper API
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
      res.setHeader("Content-Type", "text/plain");
      return res
        .status(404)
        .end(`Stop code ${stopid} was not found at location ${location}.`);
    }

    const cmStopId = matchedElement.id;

    // 2. Fetch departures for the Citymapper stop ID
    const departuresUrl = `https://citymapper.com/api/1/departures?headways=1&ids=${encodeURIComponent(
      cmStopId
    )}&region_id=sg-singapore`;

    const res2 = await axios.get(departuresUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });

    const stopData = res2.data && res2.data.stops && res2.data.stops[0];
    if (!stopData) {
      res.setHeader("Cache-Control", "s-maxage=30");
      return res.status(200).json({
        "odata.metadata":
          "http://datamall2.mytransport.sg/ltaodataservice/$metadata#BusArrivalv2/@Element",
        BusStopCode: stopid,
        Services: [],
      });
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

    console.log(`[CM Timings] Using Citymapper timings for stop ${stopid}`);
    res.setHeader("Cache-Control", "s-maxage=30");
    return res.status(200).json({
      "odata.metadata":
        "http://datamall2.mytransport.sg/ltaodataservice/$metadata#BusArrivalv2/@Element",
      BusStopCode: stopid,
      Services: formattedServices,
      CM: true,
    });
  } catch (e) {
    console.error("Backup timing API error:", e?.response?.data || e.message);
    res.setHeader("Content-Type", "text/plain");
    return res
      .status(500)
      .end("An error occurred while fetching backup bus timings.");
  }
}