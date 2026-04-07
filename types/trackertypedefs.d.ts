export type TrackerServiceSettings = Record<string, unknown>;
export type TrackerCredentials = Record<string, string>;
export type TrackerReadingStatus =
  | 'READING'
  | 'COMPLETED'
  | 'PLAN_TO_READ'
  | 'ON_HOLD'
  | 'DROPPED'
  | 'RE_READING';

export interface TrackerUserProgress {
  chapter?: number;
  volume?: number;
  rating?: number;
  lastUpdated?: string;
  status?: TrackerReadingStatus;
}

export type CredentialsRequiredCallback = (
  details?: Record<string, unknown>
) =>
  | TrackerCredentials
  | null
  | undefined
  | Promise<TrackerCredentials | null | undefined>;

export interface TrackerHttpResponseInterceptorLike {
  use(
    onFulfilled: (response: unknown) => unknown,
    onRejected: (error: unknown) => Promise<never>
  ): unknown;
}

export interface TrackerHttpClientLike {
  interceptors?: {
    response?: TrackerHttpResponseInterceptorLike;
  };
  put?: (
    url: string,
    data?: unknown,
    config?: Record<string, unknown>
  ) => Promise<{ data?: unknown }>;
  get?: (
    url: string,
    config?: Record<string, unknown>
  ) => Promise<{ data?: unknown }>;
  post?: (
    url: string,
    data?: unknown,
    config?: Record<string, unknown>
  ) => Promise<{ data?: unknown }>;
}

export interface TrackerCacheAdapterLike {
  getValue(key: string): Promise<string | null>;
  setValue(key: string, value: string, ttlSeconds?: number): Promise<void>;
}

export interface MangaUpdatesTokenResponse {
  session_token: string;
}

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
  onCredentialsRequired?: CredentialsRequiredCallback;
  httpClient?: TrackerHttpClientLike | null;
  cacheAdapter?: TrackerCacheAdapterLike | null;
}

export interface MangaUpdatesAPIWrapperInitOptions {
  apiSettings?: MangaUpdatesAPISettingsLike | null;
  serviceSettings?: TrackerServiceSettings;
  settingsPath?: string;
  onCredentialsRequired?: CredentialsRequiredCallback;
  httpClient?: TrackerHttpClientLike | null;
  httpClientFactory?: () => TrackerHttpClientLike;
  cacheAdapter?: TrackerCacheAdapterLike | null;
  cacheAdapterFactory?: () => TrackerCacheAdapterLike;
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
