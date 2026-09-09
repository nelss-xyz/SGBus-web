import axios from "axios";

const LTA_LINE_MAP = {
  STL: "SLRT",
  PTL: "PLRT",
};

export default async function handler(req, res) {
  let line = req.query.line;

  try {
    const targetLine = LTA_LINE_MAP[line] || line;

    if (targetLine === "EWL") {
      const [ewlRes, cglRes] = await Promise.all([
        axios.get(
          `https://datamall2.mytransport.sg/ltaodataservice/PCDRealTime?TrainLine=EWL`,
          {
            headers: {
              AccountKey: process.env.ACCKEY,
            },
          }
        ),
        axios
          .get(
            `https://datamall2.mytransport.sg/ltaodataservice/PCDRealTime?TrainLine=CGL`,
            {
              headers: {
                AccountKey: process.env.ACCKEY,
              },
            }
          )
          .catch((err) => {
            console.error("Failed to fetch CGL crowd data:", err);
            return { data: { value: [] } };
          }),
      ]);

      const mergedValues = [
        ...(ewlRes.data?.value || []),
        ...(cglRes.data?.value || []),
      ];

      res.setHeader("Cache-Control", "s-maxage=150");
      return res.status(200).json({
        ...ewlRes.data,
        value: mergedValues,
      });
    }

    let resp = await axios.get(
      `https://datamall2.mytransport.sg/ltaodataservice/PCDRealTime?TrainLine=${targetLine}`,
      {
        headers: {
          AccountKey: process.env.ACCKEY,
        },
      }
    );

    res.setHeader("Cache-Control", "s-maxage=150");
    return res.status(200).json(resp.data);
  } catch (e) {
    console.error(e);
    res.setHeader("Content-Type", "text/plain");
    return res.status(500).json(e);
  }
}
