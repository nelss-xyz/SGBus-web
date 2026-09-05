import axios from "axios";

const API_KEY = process.env.DATA_GOV_SG_API_KEY;
const HEADERS = API_KEY ? { "x-api-key": API_KEY } : {};

async function fetchDataset(url) {
  try {
    const res = await axios.get(url, { headers: HEADERS, timeout: 9000 });
    return res.data;
  } catch (err) {
    console.error(`[Weather API] Failed to fetch ${url}:`, err.message);
    return null;
  }
}

export default async function handler(req, res) {
  try {
    const [
      temperature,
      rainfall,
      humidity,
      pm25,
      twoHourForecast,
      twentyFourHourForecast,
      uv,
    ] = await Promise.all([
      fetchDataset(
        "https://api-open.data.gov.sg/v2/real-time/api/air-temperature"
      ),
      fetchDataset("https://api-open.data.gov.sg/v2/real-time/api/rainfall"),
      fetchDataset(
        "https://api-open.data.gov.sg/v2/real-time/api/relative-humidity"
      ),
      fetchDataset("https://api-open.data.gov.sg/v2/real-time/api/pm25"),
      fetchDataset(
        "https://api-open.data.gov.sg/v2/real-time/api/two-hr-forecast"
      ),
      fetchDataset(
        "https://api-open.data.gov.sg/v2/real-time/api/twenty-four-hr-forecast"
      ),
      fetchDataset("https://api-open.data.gov.sg/v2/real-time/api/uv"),
    ]);

    // Cache for 15 minutes (900 seconds) on Vercel Edge CDN
    res.setHeader(
      "Cache-Control",
      "s-maxage=900, stale-while-revalidate=600"
    );
    return res.status(200).json({
      temperature,
      rainfall,
      humidity,
      pm25,
      twoHourForecast,
      twentyFourHourForecast,
      uv,
    });
  } catch (fatalErr) {
    console.error("[Weather API Fatal Error]:", fatalErr.message);
    return res.status(500).json({ error: "Failed to fetch weather data" });
  }
}
