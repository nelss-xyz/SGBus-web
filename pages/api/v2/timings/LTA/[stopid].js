import axios from "axios";

function isNumeric(value) {
  return /^-?\d+$/.test(value);
}

export default async function handler(req, res) {
  const { stopid } = req.query;

  if (!stopid) {
    res.setHeader("Content-Type", "text/plain");
    return res.status(400).end("Missing required stopid parameter.");
  }

  try {
    const ltaResp = await axios.get(
      `https://datamall2.mytransport.sg/ltaodataservice/v3/BusArrival?BusStopCode=${stopid}`,
      {
        headers: {
          AccountKey: process.env.ACCKEY,
        },
        timeout: 10000,
      }
    );

    const srt = ltaResp.data;

    if (srt && Array.isArray(srt.Services)) {
      srt.Services.sort((a, b) => {
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
    }

    res.setHeader("Cache-Control", "s-maxage=30");
    return res.status(200).json(srt);
  } catch (e) {
    if (e?.response?.status === 401) {
      res.setHeader("Content-Type", "text/plain");
      return res
        .status(500)
        .end(
          "LTA's Bus arrival API is currently unavailable or under maintenance. We apologise for the inconvenience."
        );
    }

    res.setHeader("Content-Type", "text/plain");
    return res
      .status(500)
      .end("An error occurred while fetching bus timings from LTA.");
  }
}
