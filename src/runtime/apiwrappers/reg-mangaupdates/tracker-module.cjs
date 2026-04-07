'use strict';

const path = require('path');
const WrapperClass = require(path.join(__dirname, 'api-wrapper-mangaupdates.cjs'));
const SettingsClass = require(path.join(__dirname, 'api-settings-mangaupdates.cjs'));
const MapperClass = require(path.join(__dirname, 'mapper-mangaupdates.cjs'));
const { TRACKER_DTO_CONTRACT_VERSION } = require(path.join(__dirname, '..', 'trackerdtocontract.cjs'));

const serviceName = typeof WrapperClass.serviceName === 'string'
  ? WrapperClass.serviceName
  : 'mangaupdates';

module.exports = {
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
