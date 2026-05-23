import axios from "axios";
import fetch from "cross-fetch";

function isNumeric(value) {
  return /^-?\d+$/.test(value);
}

export default async function handler(req, res) {
  let stopid = req.query.stopid;
  let bid = req.query.sid;
  try {
    let resp = await axios.get(
      `http://datamall2.mytransport.sg/ltaodataservice/BusArrivalv2?BusStopCode=${stopid}&ServiceNo=${bid}`,
      {
        headers: {
          AccountKey: process.env.ACCKEY,
        },
      }
    );
    let srt = resp.data;

    srt.Services.sort((a, b) => {
      if (isNumeric(a.ServiceNo)) {
        return a.ServiceNo - b.ServiceNo;
      } else {
        return a.ServiceNo.slice(0, -1) - b.ServiceNo;
      }
    });
    res.setHeader("Cache-Control", "s-maxage=30");
    res.status(200).json(srt);
  } catch (e) {
    res.setHeader('Content-Type', 'text/plain');
    res.status(500).end("Failed to fetch data. Something went wrong.");

  }
}