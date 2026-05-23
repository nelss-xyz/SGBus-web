import fetch from "cross-fetch";

export default async function handler(req, res) {
    //   try {
    await fetch(`https://cdn.jsdelivr.net/gh/nelss-xyz/SGTransitData/Data/Output/mrt/mrt.json`)
        .then(x => x.json())
        .then((resp) => {
            res.setHeader("Cache-Control", "s-maxage=259200");
            return res.status(200).json(resp);
        })
        .catch((e) => {
            return res.status(500).json(e);
        });
}
