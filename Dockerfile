FROM cheeaun/puppeteer:1.1.1
RUN mkdir /app
WORKDIR /app

COPY package.json yarn.lock /app/
RUN yarn --production --pure-lockfile

COPY . /app

EXPOSE 3000
CMD yarn start
