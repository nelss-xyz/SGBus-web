/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async redirects() {
    return [
      {
        source: '/ps',
        destination: 'https://play.google.com/store/apps/details?id=com.slen.sgbus',
        statusCode: 301,
      },
      {
        source: '/api/v2/data/stops',
        destination: 'https://cdn.jsdelivr.net/gh/nelss-xyz/SGTransitData/Data/Output/bus/stops.json',
        statusCode: 301,
      },
      {
        source: '/api/v2/data/services',
        destination: 'https://cdn.jsdelivr.net/gh/nelss-xyz/SGTransitData/Data/Output/bus/services.json',
        statusCode: 301,
      },
      {
        source: '/api/v2/data/mrt',
        destination: 'https://raw.githubusercontent.com/nelss-xyz/SGTransitData/refs/heads/main/Data/Output/mrt/mrt.json',
        statusCode: 301,
      },
    ]
  },
}

module.exports = nextConfig
