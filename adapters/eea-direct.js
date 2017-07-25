'use strict';
import { acceptableParameters, convertUnits } from '../lib/utils';
import { REQUEST_TIMEOUT } from '../lib/constants';
import { default as baseRequest } from 'request';
import { default as moment } from 'moment-timezone';
import async from 'async';
import Papa from 'babyparse';
import uniqBy from 'lodash.uniqBy';
const request = baseRequest.defaults({timeout: REQUEST_TIMEOUT});
export const name = 'eea-direct';

export function fetchData (source, cb) {
  const metadataRequest = makeMetadataRequest(source);
  const requestTasks = makeTaskRequests(source);
  async.parallel(
    [metadataRequest, requestTasks],
    (err, res) => {
      if (err) {
       return cb(null, []);
      }
      try {
        formatData(res, source, cb);
      } catch (e) {
        cb({message: 'Error parsing the data'}, null);
      }
    });
}

// makes request used to get then format metadata for station coordinates
const makeMetadataRequest = (source) => {
  return (cb) => {
    request.get({
      url: 'http://discomap.eea.europa.eu/map/fme/metadata/PanEuropean_metadata.csv'
    }, (err, res, body) => {
      if (err || res.statusCode !== 200) {
        return cb('Could not gather current metadata, will generate records without coordinates.', []);
      }
      const data = Papa.parse(body).data;
      getCoordinates(data, source.country, cb);
    });
  };
};

// reduce metadata to list of objects with coordinates for
const getCoordinates = (metadata, country, callback) => {
  // filter for only country of interest's records
  async.filter(metadata, (record, truth) => {
    truth(record[0] === country);
  }, (countryMetadata) => {
    // map filtered records to be a list of objs w stationId/coordinates
    async.map(countryMetadata, (record, done) => {
      const station = {
        stationId: record[5],
        coordinates: {
          latitude: record[14],
          longitude: record[15]
        },
      };
      done(null, station);
    }, (err, mappedRecords) => {
      if (err) {
        return callback(null, []);
      }
      callback(null, uniqBy(mappedRecords, 'stationId'));
    });
  });
};

// makes requests to get country's pollutant data.
const makeTaskRequests = (source) => {
  const pollutantRequests = acceptableParameters.map((pollutant) => {
    pollutant = pollutant.toUpperCase();
    return (done) => {
      const url = source.url.replace('<pollutant>', pollutant);
      request.get({
        url: url
      }, (err, res, body) => {
        if (err || res.statusCode !== 200) {
          return done(null, []);
        }
        done(null, Papa.parse(body).data.slice(1, -1));
      });
    };
  });
  return (done) => {
    async.parallel(
      pollutantRequests,
      (err, response) => {
        if (err) {
          done(null, []);
        }
        done(null, [].concat.apply([], response));
      }
    );
  };
};

// formats data to match openAQ standard
const formatData = (data, source, cb) => {
  const coordinates = data[0];
  const records = data[1];
  async.map(records, (record, cb) => {
    const timeZone = record[4].split('/aq/timezone/')[1];
    let measurement = {
      parameter: record[5],
      date: makeDate(record[16], timeZone),
      coordinates: makeCoordinates(coordinates, record[11]),
      value: record[19],
      unit: record[record.length - 1],
      attribution: [{
        name: 'EEA',
        url: source.sourceUrl
      }],
      averagingPeriod: {
        unit: 'hours',
        value: makeAvgPeriod(record.slice(15, 17)).toString()
      }
    };
    // apply unit conversion to generated record
    cb(null, convertUnits([measurement])[0]);
  }, (err, mappedRecords) => {
    if (err) {
      return cb(null, []);
    }
    cb(null, mappedRecords);
  });
};

const makeCoordinates = (coordinatesList, stationId) => {
  return coordinatesList.filter((coordinates) => {
    return coordinates.stationId === stationId;
  }).map((station) => {
    return {
      latitude: parseFloat(station.coordinates.latitude),
      longitude: parseFloat(station.coordinates.longitude)
    };
  })[0];
};

const makeAvgPeriod = (delta) => {
  const latestTime = moment.tz(delta[1], 'YYYY-MM-DD hh:mm:ss', 'Europe/Berlin');
  const earliestTime = moment.tz(delta[0], 'YYYY-MM-DD hh:mm:ss', 'Europe/Berlin');
  return moment(latestTime).diff(earliestTime, 'hours');
};

const makeDate = (date, timeZone) => {
  switch (timeZone) {
    case 'UTC+01':
      timeZone = 'Europe/Lisbon';
      break;
    case 'UTC+02':
      timeZone = 'Europe/Madrid';
      break;
    case 'UTC+03':
      timeZone = 'Europe/Helsinki';
      break;
    case 'UTC+04':
      timeZone = 'Asia/Tbilisi';
      break;
    case 'UTC-04':
      timeZone = 'America/New_York';
      break;
    case 'UTC-03':
      timeZone = 'Atlantic/Bermuda';
      break;
    case 'UTC':
      timeZone = 'Atlantic/Azores';
      break;
    default:
      break;
  }
  date = moment.tz(date, 'YYYY-MM-DD hh:mm:ss', timeZone);
  return {
    utc: date.toDate(),
    local: date.format()
  };
};