require('dotenv').config();

const config = {
  JWT_SECRET_KEY: process.env.JWT_SECRET_KEY, // You can default to a hardcoded key if no environment variable is set
  REFRESH_TOKEN_SECRET: process.env.REFRESH_TOKEN_SECRET, // Same as above
};

module.exports = config;
