import axios from "axios";

const LTA_HEADERS = { headers: { AccountKey: process.env.ACCKEY } };

/** Fetches train service alerts from LTA DataMall. */
async function fetchTrainAlerts() {
  const resp = await axios.get(
    "https://datamall2.mytransport.sg/ltaodataservice/TrainServiceAlerts",
    LTA_HEADERS
  );
  return resp.data.value.Message.map((m) => ({
    header: "Train service alert",
    message: m.Content,
    link: "",
    linkDesc: "",
    type: "text",
  }));
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
    console.error("Failed to fetch custom alerts:", err.message);
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
    console.error("Failed to fetch last updated date:", err.message);
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

    res.setHeader("Cache-Control", "s-maxage=300");
    res.status(200).json({
      alerts: [...trainAlerts, ...customAlerts],
      lastUpdated,
    });
  } catch (err) {
    console.error("Launch API error:", err.message);
    res.status(500).json({ alerts: [], error: true });
  }
}
