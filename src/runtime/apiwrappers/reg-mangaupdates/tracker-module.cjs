'use strict';

const path = require('path');
const WrapperClass = require(path.join(__dirname, 'api-wrapper-mangaupdates.cjs'));
const SettingsClass = require(path.join(__dirname, 'api-settings-mangaupdates.cjs'));
const MapperClass = require(path.join(__dirname, 'mapper-mangaupdates.cjs'));
const { TRACKER_DTO_CONTRACT_VERSION } = require(path.join(__dirname, '..', 'trackerdtocontract.cjs'));

/** @typedef {import('../../../../types/trackertypedefs').MangaUpdatesTrackerModuleDescriptor} MangaUpdatesTrackerModuleDescriptor */

const serviceName = typeof WrapperClass.serviceName === 'string'
  ? WrapperClass.serviceName
  : 'mangaupdates';

/** @type {MangaUpdatesTrackerModuleDescriptor} */
const trackerModule = {
  serviceName,
  wrapperId: 'mangaupdates',
  dtoContractVersion: TRACKER_DTO_CONTRACT_VERSION,
  mapperEntry: 'apiwrappers/reg-mangaupdates/mapper-mangaupdates.cjs',
  supportsCoverSearch: true,
  supportsCoverDownload: true,
  supportsCoverUpload: false,
  maxUploadSize: null,
  acceptedMimeTypes: [],
  WrapperClass,
  MapperClass,
  SettingsClass,
};

module.exports = trackerModule;
