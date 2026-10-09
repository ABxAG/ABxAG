/**
 * Model registry: configuration-driven list of providers and models.
 *
 * Built-in defaults are merged with `<data>/models/models.json`, which may add
 * new providers/models or override fields of existing ones by ID. Provider
 * adapters are created from `apiType`; nothing else in ABxAG branches on a
 * provider or model name.
 */
import path from "node:path";
import { readJsonFile, writeJsonFile } from "../shared/jsonFile";
import { DEFAULT_MODELS, DEFAULT_PROVIDERS } from "./defaults";
import { AnthropicCompatibleProvider } from "./providers/anthropicCompatible";
import { GeminiProvider } from "./providers/gemini/client";
import { OpenAICompatibleProvider } from "./providers/openaiCompatible";
import type { ModelDefinition, ModelProvider, ModelTask, ProviderConfig } from "./types";

export type ModelAvailability = "available" | "unverified" | "unavailable" | "not_configured" | "disabled";

export interface ModelSelection {
  /** "auto" or a model ID. Used for conversation, planning and vision. */
  brain: string;
  /** Model used for the realtime voice session. */
  live: string;
  /** Background work (memory consolidation, summaries): "auto" prefers light models with separate quotas. */
  background: string;
  /** Allow switching to another model when the selected one fails. */
  fallbackAllowed: boolean;
  /** Permit local models when offline even if a cloud model is selected. */
  offlineLocalFallback: boolean;
}

interface UserModelFile {
  providers?: Array<Partial<ProviderConfig> & { id: string }>;
  models?: Array<Partial<ModelDefinition> & { id: string }>;
}

export const DEFAULT_SELECTION: ModelSelection = {
  brain: "gemini-3.5-flash",
  live: "gemini-3.1-flash-live-preview",
  background: "auto",
  fallbackAllowed: true,
  offlineLocalFallback: true,
};

export class ModelRegistry {
  private providers = new Map<string, ProviderConfig>();
  private models = new Map<string, ModelDefinition>();
  private adapters = new Map<string, ModelProvider>();
  private available = new Map<string, Set<string>>();
  private availabilityError = new Map<string, string>();
  private selection: ModelSelection = { ...DEFAULT_SELECTION };
  private readonly listeners = new Set<(selection: ModelSelection) => void>();
  private readonly userFile: string;
  private readonly selectionFile: string;

  constructor(private readonly dataDir: string, private readonly getSecret: (name: string) => string | undefined) {
    this.userFile = path.join(dataDir, "models", "models.json");
    this.selectionFile = path.join(dataDir, "models", "selection.json");
  }

  async initialize(legacyEnv: NodeJS.ProcessEnv = process.env): Promise<void> {
    const user = await readJsonFile<UserModelFile>(this.userFile, {});
    this.providers = new Map(DEFAULT_PROVIDERS.map((provider) => [provider.id, { ...provider }]));
    for (const override of user.providers || []) {
      if (!override?.id) continue;
      const base = this.providers.get(override.id);
      this.providers.set(override.id, { ...(base || { apiType: "openai-compatible", displayName: override.id, enabled: true, locality: "cloud" }), ...override } as ProviderConfig);
    }
    this.models = new Map(DEFAULT_MODELS.map((model) => [model.id, structuredClone(model)]));
    for (const override of user.models || []) {
      if (!override?.id) continue;
      const base = this.models.get(override.id);
      const merged = { ...(base || {}), ...override, capabilities: { ...(base?.capabilities || {}), ...(override.capabilities || {}) } } as ModelDefinition;
      if (!merged.provider || !merged.modelName || !merged.apiType) continue;
      merged.recommendedTasks = merged.recommendedTasks || [];
      merged.enabled = merged.enabled !== false;
      this.models.set(merged.id, merged);
    }
    this.adapters.clear();
    for (const provider of this.providers.values()) this.adapters.set(provider.id, this.createAdapter(provider));

    const storedSelection = await readJsonFile<Partial<ModelSelection> | null>(this.selectionFile, null);
    if (storedSelection) {
      this.selection = { ...DEFAULT_SELECTION, ...storedSelection };
    } else {
      // Migrate the previous env-based route so an existing setup keeps its model.
      const legacy = (legacyEnv.ABxAG_REASONING_MODEL || "").split(",")[0]?.trim();
      if (legacy && this.models.has(legacy)) this.selection.brain = legacy;
      const legacyLive = (legacyEnv.ABxAG_SPEECH_MODEL || "").split(",")[0]?.trim();
      if (legacyLive && this.models.get(legacyLive)?.capabilities.liveAudio) this.selection.live = legacyLive;
    }
    if (this.selection.brain !== "auto" && !this.models.has(this.selection.brain)) this.selection.brain = DEFAULT_SELECTION.brain;
    if (!this.models.get(this.selection.live)?.capabilities.liveAudio) this.selection.live = DEFAULT_SELECTION.live;
  }

  private createAdapter(provider: ProviderConfig): ModelProvider {
    const key = () => (provider.secretName ? this.getSecret(provider.secretName) : undefined);
    switch (provider.apiType) {
      case "gemini": return new GeminiProvider(provider, key);
      case "anthropic-compatible": return new AnthropicCompatibleProvider(provider, key);
      case "openai-compatible":
      default:
        return new OpenAICompatibleProvider(provider, key);
    }
  }

  /** Register an adapter directly (tests, or custom in-process providers). */
  registerAdapter(providerId: string, adapter: ModelProvider): void {
    this.adapters.set(providerId, adapter);
    if (!this.providers.has(providerId)) this.providers.set(providerId, adapter.config);
  }

  /** Add or replace a model definition at runtime (persist with saveUserModel). */
  upsertModel(model: ModelDefinition): void {
    this.models.set(model.id, model);
  }

  async saveUserModel(model: Partial<ModelDefinition> & { id: string }): Promise<void> {
    const user = await readJsonFile<UserModelFile>(this.userFile, {});
    const models = (user.models || []).filter((item) => item.id !== model.id);
    models.push(model);
    await writeJsonFile(this.userFile, { ...user, models });
    await this.initialize();
  }

  getModel(id: string): ModelDefinition | undefined {
    return this.models.get(id);
  }

  getProviderConfig(id: string): ProviderConfig | undefined {
    return this.providers.get(id);
  }

  adapterFor(model: ModelDefinition): ModelProvider | undefined {
    return this.adapters.get(model.provider);
  }

  allModels(): ModelDefinition[] {
    return [...this.models.values()];
  }

  availability(model: ModelDefinition): ModelAvailability {
    const provider = this.providers.get(model.provider);
    if (!model.enabled || !provider?.enabled) return "disabled";
    const adapter = this.adapters.get(model.provider);
    if (!adapter?.isConfigured()) return "not_configured";
    const names = this.available.get(model.provider);
    if (!names) return "unverified";
    return names.has(model.modelName) ? "available" : "unavailable";
  }

  /** Query each configured provider's model list (bounded, best-effort). */
  async refreshAvailability(signal?: AbortSignal): Promise<void> {
    await Promise.all([...this.providers.values()].filter((provider) => provider.enabled).map(async (provider) => {
      const adapter = this.adapters.get(provider.id);
      if (!adapter?.isConfigured() || !adapter.listModels) return;
      try {
        const names = await adapter.listModels({ signal, timeoutMs: 12_000 });
        this.available.set(provider.id, new Set(names));
        this.availabilityError.delete(provider.id);
      } catch (error) {
        this.availabilityError.set(provider.id, error instanceof Error ? error.message : String(error));
      }
    }));
  }

  getSelection(): ModelSelection {
    return { ...this.selection };
  }

  async setSelection(patch: Partial<ModelSelection>): Promise<ModelSelection> {
    const next = { ...this.selection, ...patch };
    if (next.brain !== "auto" && !this.models.get(next.brain)) throw new Error(`Unknown model ${next.brain}`);
    if (next.background !== "auto" && !this.models.get(next.background)) throw new Error(`Unknown model ${next.background}`);
    if (!this.models.get(next.live)?.capabilities.liveAudio) throw new Error(`${next.live} is not a realtime voice model.`);
    this.selection = next;
    await writeJsonFile(this.selectionFile, this.selection);
    for (const listener of this.listeners) listener(this.getSelection());
    return this.getSelection();
  }

  onSelectionChange(listener: (selection: ModelSelection) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Renderer-safe catalogue (no keys, no base URLs with credentials). */
  publicCatalogue() {
    return {
      selection: this.getSelection(),
      providers: [...this.providers.values()].map((provider) => ({
        id: provider.id,
        displayName: provider.displayName,
        apiType: provider.apiType,
        locality: provider.locality,
        enabled: provider.enabled,
        configured: Boolean(this.adapters.get(provider.id)?.isConfigured()),
        verificationError: this.availabilityError.get(provider.id) || null,
      })),
      models: this.allModels().map((model) => ({
        id: model.id,
        displayName: model.displayName,
        provider: model.provider,
        providerName: this.providers.get(model.provider)?.displayName || model.provider,
        locality: model.locality,
        tier: model.tier,
        capabilities: model.capabilities,
        contextLength: model.contextLength,
        recommendedTasks: model.recommendedTasks as ModelTask[],
        description: model.description || "",
        icon: model.icon || null,
        accent: model.accent || null,
        cost: model.cost,
        availability: this.availability(model),
      })),
    };
  }
}



