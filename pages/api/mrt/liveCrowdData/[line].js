import axios from "axios";

export default async function handler(req, res) {

    let line = req.query.line;

    try {
        let resp = await axios.get(
            `https://datamall2.mytransport.sg/ltaodataservice/PCDRealTime?TrainLine=${line}`,
            {
                headers: {
                    AccountKey: process.env.ACCKEY,
                },
            }
        );
        res.setHeader("Cache-Control", "s-maxage=30");
        res.status(200).json(resp.data);
    } catch (e) {

        console.log(e)

        res.setHeader('Content-Type', 'text/plain');
        res.status(500).json(e)
        // res.status(500).end("An unknown error has occured. Please try again later.");
    }
}