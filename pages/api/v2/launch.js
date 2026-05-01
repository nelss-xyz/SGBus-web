import axios from "axios";
import crypto from "crypto";
import { Redis } from "@upstash/redis";
import { GoogleGenAI } from "@google/genai";
import { getSystemPrompt } from "./../../../config/LTAAlertPrompt.js";

const LTA_HEADERS = { headers: { AccountKey: process.env.ACCKEY } };

const redis = Redis.fromEnv();
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

/** Fetches train service alerts from LTA DataMall. */
async function fetchTrainAlerts() {
  try {
    const resp = await axios.get(
      "https://datamall2.mytransport.sg/ltaodataservice/TrainServiceAlerts",
      LTA_HEADERS
    );

    const ltaData = resp.data.value;

    // Safety check: Return empty array if data is missing or empty
    if (!ltaData || !ltaData.Message || ltaData.Message.length === 0) {
      return [];
    }

    // Stringify the affected segments (stations, shuttles) to give the AI context
    const segmentsContext = ltaData.AffectedSegments && ltaData.AffectedSegments.length > 0
      ? JSON.stringify(ltaData.AffectedSegments)
      : "No segment data provided.";

    const alertPromises = ltaData.Message.map(async (m) => {
      const rawText = m.Content;

      // Hash the raw text to use as our Redis cache key
      const textHash = crypto.createHash('md5').update(rawText).digest('hex');
      const cacheKey = `ai_summary_${textHash}`;

      let aiSummaryString;

      let parsedData;

      // 1. Safe Redis Fetch (Upstash automatically parses JSON!)
      try {
        parsedData = await redis.get(cacheKey);
      } catch (redisErr) {
        console.error(`[Redis Get Error] Failed to fetch cache for ${cacheKey}:`, redisErr.message);
      }

      // If parsedData is null, we had a cache miss
      if (!parsedData) {
        const model = "gemini-2.5-flash";
        console.log(`Cache miss! Processing with ${model}...`);

        const aiInput = `Raw Message: "${rawText}"\nAffected Segments: ${segmentsContext}`;

        try {
          const response = await ai.models.generateContent({
            model: model,
            contents: aiInput,
            config: {
              systemInstruction: getSystemPrompt(),
              responseMimeType: "application/json",
              temperature: 0.1,
            }
          });

          // Parse Gemini's JSON string immediately into a JS Object
          parsedData = JSON.parse(response.text);

          // 3. Safe Redis Set (Upstash automatically stringifies objects!)
          try {
            await redis.set(cacheKey, parsedData, { ex: 86400 });
          } catch (redisSetErr) {
            console.error(`[Redis Set Error] Failed to save cache for ${cacheKey}:`, redisSetErr.message);
          }

        } catch (aiErr) {
          console.error("[Gemini/Parse Error] Failed to process AI:", aiErr.message);
          return [{
            header: "Transit Alert",
            message: rawText,
            link: "",
            linkDesc: "",
            type: "text",
            ai: false,
          }];
        }
      }

      // 4. Mapping the Data
      // No JSON.parse needed here! parsedData is already a native JS object 
      // whether it came from Gemini or from the Redis cache.
      try {
        return parsedData.alerts.map(alert => ({
          header: alert.header,
          message: alert.content,
          affectedLine: alert.affectedLine || "N/A",
          category: alert.alertCategory,
          severity: alert.severity,
          link: "",
          linkDesc: "",
          type: "text",
          ai: true,
        }));
      } catch (err) {
        console.error("[Mapping Error] Failed to map parsed data:", err.message);
        return [{
          header: "Transit alert",
          message: rawText,
          link: "",
          linkDesc: "",
          type: "text",
          ai: false,
        }];
      }
    });

    const nestedAlerts = await Promise.all(alertPromises);
    return nestedAlerts.flat();

  } catch (err) {
    // 5. Fatal Catch: Prevents "trainAlerts is not iterable" in the main handler
    console.error("[LTA API Error] Fatal error in fetchTrainAlerts:", err.message);
    return [];
  }
}

/** Fetches custom app alerts from npoint. Returns [] on failure. */
async function fetchCustomAlerts() {
  try {
    const resp = await axios.get(process.env.NPOINT_URL2);
    return resp.data.map((a) => ({
      header: a.header,
      message: a.message,
      link: a.link,
      linkDesc: a.linkDesc,
      type: a.type,
      startTimestamp: a.startTimestamp,
      endTimestamp: a.endTimestamp,
      crowdMap: a.crowdMap,
    }));
  } catch (err) {
    console.error("[Npoint API Error] Failed to fetch custom alerts:", err.message);
    return [];
  }
}

/** Fetches the latest commit date from the sgbusdata repo. Returns null on failure. */
async function fetchLastUpdated() {
  try {
    const resp = await axios.get(
      "https://api.github.com/repos/cheeaun/sgbusdata/commits"
    );
    return resp.data[0].commit.committer.date;
  } catch (err) {
    console.error("[Github API Error] Failed to fetch last updated date:", err.message);
    return null;
  }
}

export default async function handler(req, res) {
  try {
    const [trainAlerts, customAlerts, lastUpdated] = await Promise.all([
      fetchTrainAlerts(),
      fetchCustomAlerts(),
      fetchLastUpdated(),
    ]);

    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    res.status(200).json({
      alerts: [...trainAlerts, ...customAlerts],
      lastUpdated,
    });
  } catch (err) {
    console.error("[Launch API Fatal Error]:", err.message);
    res.status(500).json({ alerts: [], error: true });
  }
}