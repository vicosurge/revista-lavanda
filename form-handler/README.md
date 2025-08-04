# form-handler API

## Install Vercel CLI
npm i -g vercel

## Clone/create your project directory
mkdir form-handler
cd form-handler

## Initialize package.json and install dependencies
npm init -y
npm install formidable@^3.5.1 node-fetch@^2.7.0 form-data@^4.0.0

## Create the API directory and function
mkdir -p api

## Vercel login
vercel login
vercel --prod
