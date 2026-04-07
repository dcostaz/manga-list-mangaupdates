export type TrackerServiceSettings = Record<string, unknown>;

export interface MangaUpdatesSettingsDocument {
  metadata: Record<string, unknown>;
  schema: Record<string, unknown>;
  settings: TrackerServiceSettings;
}

export interface MangaUpdatesAPISettingsInitOptions {
  settingsPath?: string;
  defaultSettings?: TrackerServiceSettings;
}

export interface MangaUpdatesAPISettingsConstructorParams {
  settings?: TrackerServiceSettings | MangaUpdatesSettingsDocument;
  settingsPath?: string;
}

export interface MangaUpdatesAPISettingsLike {
  componentName: string;
  toLegacyFormat(): TrackerServiceSettings;
}

export interface MangaUpdatesAPIWrapperCtorParams {
  apiSettings?: MangaUpdatesAPISettingsLike | null;
  serviceSettings?: TrackerServiceSettings;
}

export interface MangaUpdatesAPIWrapperInitOptions {
  apiSettings?: MangaUpdatesAPISettingsLike | null;
  serviceSettings?: TrackerServiceSettings;
}

export interface MangaUpdatesRawSearchItem {
  id: string;
  title: string;
}

export interface MangaUpdatesRawSearchResponse {
  trackerId: string;
  operation: string;
  payload: {
    data: MangaUpdatesRawSearchItem[];
  };
}

export interface MangaUpdatesRawEntityResponse {
  trackerId: string;
  operation: string;
  payload: Record<string, unknown>;
}

export interface MangaUpdatesSeriesDetailDto {
  trackerId: string;
  source: string;
  title: string;
  alternativeTitles: string[];
  description: string | null;
  status: string | null;
  year: number | null;
  url: string | null;
  metadata: Record<string, unknown> | null;
}

export interface MangaUpdatesStatusDto {
  status?: string;
  chapter: number | null;
  volume: number | null;
  rating: number | null;
  lastUpdated: string | null;
}

export interface MangaUpdatesTrackerModuleDescriptor {
  serviceName: string;
  wrapperId: string;
  dtoContractVersion: string;
  mapperEntry: string;
  supportsCoverSearch: boolean;
  supportsCoverDownload: boolean;
  supportsCoverUpload: boolean;
  maxUploadSize: number | null;
  acceptedMimeTypes: string[];
  WrapperClass: Function;
  MapperClass: Function;
  SettingsClass: Function;
}
