export type ApiAuthType = "none" | "apiKey" | "oauth" | "custom" | "unknown";

export type ApiProviderStatus =
  | "READY_NO_AUTH"
  | "NEEDS_API_KEY"
  | "NEEDS_OAUTH"
  | "BROKEN"
  | "UNSUPPORTED"
  | "UNKNOWN";

export type TernarySupport = "yes" | "no" | "unknown";

export interface ApiProviderHealth {
  state: "unchecked" | "healthy" | "degraded" | "broken";
  checkedAt: string | null;
  statusCode: number | null;
  latencyMs: number | null;
  consecutiveFailures: number;
  error: string | null;
}

export interface ApiProvider {
  id: string;
  name: string;
  description: string;
  category: string;
  documentationUrl: string;
  auth: ApiAuthType;
  authRaw: string;
  https: TernarySupport;
  cors: TernarySupport;
  status: ApiProviderStatus;
  cataloguePresent: boolean;
  source: string;
  firstSeenAt: string;
  updatedAt: string;
  health: ApiProviderHealth;
}

export interface ApiCatalogueMetadata {
  source: string;
  syncedAt: string | null;
  sourceEtag: string | null;
  sourceLastModified: string | null;
  imported: number;
  duplicates: number;
  rejected: number;
}

export interface ApiRegistryFile {
  version: 1;
  metadata: ApiCatalogueMetadata;
  providers: ApiProvider[];
}

export interface ParsedCatalogue {
  providers: Array<Omit<ApiProvider, "firstSeenAt" | "updatedAt" | "health">>;
  duplicates: number;
  rejected: number;
}

export interface ApiSearchResult {
  provider: ApiProvider;
  score: number;
  matchedTerms: string[];
}

export interface ApiCatalogueSummary {
  source: string;
  syncedAt: string | null;
  providerCount: number;
  categories: number;
  statuses: Record<ApiProviderStatus, number>;
  health: Record<ApiProviderHealth["state"], number>;
}

export interface AdapterParameter {
  name: string;
  in: "path" | "query" | "header" | "body";
  required?: boolean;
  default?: string | number | boolean;
}

export interface DeclarativeApiAdapter {
  id: string;
  providerId: string;
  capability: string;
  method: "GET" | "POST";
  urlTemplate: string;
  parameters: AdapterParameter[];
  output: Record<string, string>;
  credentialEnv?: string;
  credentialHeader?: string;
  credentialPrefix?: string;
  verified: boolean;
  verifiedAt: string | null;
  verificationNotes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApiAdapterExecutionResult {
  adapterId: string;
  providerId: string;
  capability: string;
  sourceUrl: string;
  sourceStatus: number;
  timestamp: string;
  data: Record<string, unknown>;
}
