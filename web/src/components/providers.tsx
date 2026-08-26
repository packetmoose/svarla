import { h, Component, Fragment } from "preact";
import { api } from "../api";

/* ---------- Types ---------- */

interface ProviderSummary {
  id: string;
  type: string;
  displayName: string;
  enabled: boolean;
  connected?: boolean;
}

interface ProviderDetail extends ProviderSummary {
  config: Record<string, unknown>;
  webhookUrls: string[];
}

interface FieldError {
  field: string;
  message: string;
}

interface ModemStatus {
  connected: boolean;
  signal: number | null;
  network: string | null;
  operator: string | null;
  modemModel: string | null;
  modemManufacturer: string | null;
  firmware: string | null;
  stale: string[] | null;
  modemUnsupportedWarning: string | null;
}

interface Notification {
  message: string;
  type: "success" | "error";
  id: number;
}

/* ---------- Config field definitions per provider type ---------- */

interface ConfigFieldDef {
  name: string;
  label: string;
  type: "text" | "password" | "textarea";
  required: boolean;
}

const CONFIG_FIELDS: Record<string, ConfigFieldDef[]> = {
  vonage: [
    { name: "api_key", label: "API Key", type: "text", required: true },
    { name: "api_secret", label: "API Secret", type: "password", required: true },
    { name: "application_id", label: "Application ID", type: "text", required: true },
    { name: "private_key", label: "Private Key (PEM)", type: "textarea", required: true },
  ],
  "46elks": [
    { name: "api_username", label: "API Username", type: "text", required: true },
    { name: "api_password", label: "API Password", type: "password", required: true },
    { name: "websocket_number", label: "WebSocket Number", type: "text", required: false },
  ],
  dummy: [],
  "modem-gateway": [],
};

/* ---------- Pairing secret generation (client-side) ---------- */

/**
 * Generate a pairing secret: 6-8 case-insensitive alphanumeric characters.
 * Uses crypto.getRandomValues() for secure generation in the browser.
 */
function generatePairingSecret(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const randomByte = new Uint8Array(1);
  crypto.getRandomValues(randomByte);
  const length = 6 + (randomByte[0] % 3);
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let secret = "";
  for (let i = 0; i < length; i++) {
    secret += chars[bytes[i] % chars.length];
  }
  return secret;
}

/* ---------- State ---------- */

interface ProvidersState {
  providers: ProviderSummary[];
  loading: boolean;
  selectedProvider: ProviderDetail | null;
  detailLoading: boolean;

  // Add form state
  showForm: boolean;
  formType: string;
  formDisplayName: string;
  formConfig: Record<string, string>;
  formErrors: FieldError[];
  formSubmitting: boolean;

  // Pairing secret display (shown after creation or reset)
  showPairingSecret: string | null;
  pairingSecretWsEndpoint: string | null;

  // Reset pairing state
  resetTarget: ProviderSummary | null;
  resetLoading: boolean;
  resetSecret: string | null;

  // Edit form state
  editingProvider: ProviderDetail | null;
  editDisplayName: string;
  editConfig: Record<string, string>;
  editErrors: FieldError[];
  editSubmitting: boolean;

  // Delete confirmation
  deleteTarget: ProviderSummary | null;
  deleteLoading: boolean;

  // Modem status (for modem-gateway providers)
  modemStatus: ModemStatus | null;
  modemStatusLoading: boolean;

  // Sync state
  syncingProviderId: string | null;

  // Notifications
  notifications: Notification[];
}

let notificationCounter = 0;

/* ---------- Component ---------- */

export class Providers extends Component<Record<string, never>, ProvidersState> {
  private statusPollTimer: ReturnType<typeof setInterval> | null = null;

  state: ProvidersState = {
    providers: [],
    loading: true,
    selectedProvider: null,
    detailLoading: false,
    showForm: false,
    formType: "vonage",
    formDisplayName: "",
    formConfig: {},
    formErrors: [],
    formSubmitting: false,
    showPairingSecret: null,
    pairingSecretWsEndpoint: null,
    resetTarget: null,
    resetLoading: false,
    resetSecret: null,
    editingProvider: null,
    editDisplayName: "",
    editConfig: {},
    editErrors: [],
    editSubmitting: false,
    deleteTarget: null,
    deleteLoading: false,
    modemStatus: null,
    modemStatusLoading: false,
    syncingProviderId: null,
    notifications: [],
  };

  componentDidMount() {
    this.fetchProviders();
  }

  componentWillUnmount() {
    this.stopStatusPolling();
  }

  /* ---------- Data fetching ---------- */

  private fetchProviders = async () => {
    this.setState({ loading: true });
    const result = await api.get<{ providers: ProviderSummary[] }>("/api/providers");
    if (result.ok) {
      this.setState({ providers: result.data.providers, loading: false });
    } else {
      this.setState({ loading: false });
      this.showNotification("Failed to load providers", "error");
    }
  };

  private fetchProviderDetail = async (id: string) => {
    this.setState({ detailLoading: true, modemStatus: null });
    const result = await api.get<ProviderDetail>(`/api/providers/${id}`);
    if (result.ok) {
      this.setState({ selectedProvider: result.data, detailLoading: false });
      // Start polling modem status for modem-gateway providers
      if (result.data.type === "modem-gateway") {
        this.fetchModemStatus(result.data.id);
        this.startStatusPolling(result.data.id);
      } else {
        this.stopStatusPolling();
      }
    } else {
      this.setState({ detailLoading: false });
      this.showNotification("Failed to load provider details", "error");
    }
  };

  private fetchModemStatus = async (id: string) => {
    this.setState({ modemStatusLoading: true });
    const result = await api.get<ModemStatus>(`/api/providers/${id}/status`);
    if (result.ok) {
      this.setState({ modemStatus: result.data, modemStatusLoading: false });
    } else {
      this.setState({ modemStatusLoading: false });
    }
  };

  private startStatusPolling(id: string) {
    this.stopStatusPolling();
    this.statusPollTimer = setInterval(() => {
      this.fetchModemStatus(id);
    }, 10_000);
  }

  private stopStatusPolling() {
    if (this.statusPollTimer) {
      clearInterval(this.statusPollTimer);
      this.statusPollTimer = null;
    }
  }

  /* ---------- Notifications ---------- */

  private showNotification = (message: string, type: "success" | "error") => {
    const id = ++notificationCounter;
    this.setState((prev) => ({
      notifications: [...prev.notifications, { message, type, id }],
    }));
    setTimeout(() => {
      this.setState((prev) => ({
        notifications: prev.notifications.filter((n) => n.id !== id),
      }));
    }, 4000);
  };

  /* ---------- Toggle enable/disable ---------- */

  private handleToggleEnabled = async (provider: ProviderSummary) => {
    const result = await api.put<ProviderDetail>(`/api/providers/${provider.id}`, {
      enabled: !provider.enabled,
    });
    if (result.ok) {
      this.setState((prev) => ({
        providers: prev.providers.map((p) =>
          p.id === provider.id ? { ...p, enabled: !p.enabled } : p
        ),
      }));
      this.showNotification(
        `Provider "${provider.displayName}" ${provider.enabled ? "disabled" : "enabled"}`,
        "success"
      );
    } else {
      const errorData = result.data as { error?: string };
      this.showNotification(errorData.error || "Failed to update provider", "error");
    }
  };

  /* ---------- Delete flow ---------- */

  private handleDeleteClick = (provider: ProviderSummary) => {
    this.setState({ deleteTarget: provider });
  };

  private handleDeleteCancel = () => {
    this.setState({ deleteTarget: null });
  };

  private handleDeleteConfirm = async () => {
    const { deleteTarget } = this.state;
    if (!deleteTarget) return;

    this.setState({ deleteLoading: true });
    const result = await api.delete<void>(`/api/providers/${deleteTarget.id}`);

    if (result.ok || result.status === 204) {
      this.setState((prev) => ({
        providers: prev.providers.filter((p) => p.id !== deleteTarget.id),
        deleteTarget: null,
        deleteLoading: false,
        selectedProvider:
          prev.selectedProvider?.id === deleteTarget.id ? null : prev.selectedProvider,
      }));
      this.showNotification(`Provider "${deleteTarget.displayName}" removed`, "success");
    } else {
      const errorData = result.data as { error?: string };
      this.setState({ deleteTarget: null, deleteLoading: false });
      this.showNotification(errorData.error || "Failed to remove provider", "error");
    }
  };

  /* ---------- Sync handler ---------- */

  private handleSync = async (provider: ProviderSummary) => {
    this.setState({ syncingProviderId: provider.id });

    const result = await api.post<{ added: string[]; removed: string[]; total: number }>(
      "/api/numbers/sync",
      { providerId: provider.id }
    );

    this.setState({ syncingProviderId: null });

    if (result.ok) {
      const { added, removed, total } = result.data;
      if (added.length === 0 && removed.length === 0) {
        this.showNotification(`"${provider.displayName}" is up to date (${total} numbers)`, "success");
      } else {
        const parts: string[] = [];
        if (added.length > 0) parts.push(`${added.length} added`);
        if (removed.length > 0) parts.push(`${removed.length} removed`);
        this.showNotification(
          `Synced "${provider.displayName}": ${parts.join(", ")} (${total} total)`,
          "success"
        );
      }
    } else {
      const errorData = result.data as { error?: string };
      this.showNotification(errorData.error || "Sync failed", "error");
    }
  };

  /* ---------- Edit form handlers ---------- */

  private handleEditClick = (provider: ProviderDetail) => {
    // Convert config values to strings for the form, replacing masked values with empty
    const editConfig: Record<string, string> = {};
    const fields = CONFIG_FIELDS[provider.type] || [];
    for (const field of fields) {
      const value = provider.config[field.name];
      // Masked values (e.g. "****abcd") should show as empty — user re-enters if changing
      const strValue = typeof value === "string" ? value : "";
      const isMasked = strValue.startsWith("*");
      editConfig[field.name] = isMasked ? "" : strValue;
    }

    this.setState({
      editingProvider: provider,
      editDisplayName: provider.displayName,
      editConfig,
      editErrors: [],
      selectedProvider: null, // close detail view
    });
  };

  private handleEditCancel = () => {
    this.setState({ editingProvider: null, editErrors: [] });
  };

  private handleEditDisplayNameChange = (e: Event) => {
    this.setState({ editDisplayName: (e.target as HTMLInputElement).value });
  };

  private handleEditConfigFieldChange = (field: string, value: string) => {
    this.setState((prev) => ({
      editConfig: { ...prev.editConfig, [field]: value },
    }));
  };

  private handleEditSubmit = async (e: Event) => {
    e.preventDefault();
    const { editingProvider, editDisplayName, editConfig } = this.state;
    if (!editingProvider) return;

    this.setState({ editSubmitting: true, editErrors: [] });

    // Build the update payload — only include config fields that are non-empty
    // (empty fields mean "keep existing value" for secrets that were masked)
    const configUpdate: Record<string, string> = {};
    const fields = CONFIG_FIELDS[editingProvider.type] || [];
    for (const field of fields) {
      const value = editConfig[field.name] ?? "";
      if (value.length > 0) {
        configUpdate[field.name] = value;
      } else {
        // Keep the existing value from the server (it's masked, so we can't send it back)
        // We need to include the masked value to not clear it — but the server should
        // ignore masked values. For now, omit empty fields entirely so the server
        // keeps the existing encrypted value.
      }
    }

    const body: Record<string, unknown> = {};
    if (editDisplayName !== editingProvider.displayName) {
      body.displayName = editDisplayName;
    }
    if (Object.keys(configUpdate).length > 0) {
      body.config = configUpdate;
    }

    // If nothing changed, just close
    if (Object.keys(body).length === 0) {
      this.setState({ editingProvider: null, editSubmitting: false });
      return;
    }

    const result = await api.put<ProviderDetail>(
      `/api/providers/${editingProvider.id}`,
      body
    );

    if (result.ok) {
      await this.fetchProviders();
      this.setState({
        editingProvider: null,
        editSubmitting: false,
        editErrors: [],
      });
      this.showNotification("Provider updated successfully", "success");
    } else {
      const errorData = result.data as { error?: string; fieldErrors?: FieldError[] };
      this.setState({
        editSubmitting: false,
        editErrors: errorData.fieldErrors || [
          { field: "general", message: errorData.error || "Failed to update provider" },
        ],
      });
    }
  };

  /* ---------- Add form handlers ---------- */

  private handleShowForm = () => {
    this.setState({
      showForm: true,
      formType: "vonage",
      formDisplayName: "",
      formConfig: {},
      formErrors: [],
    });
  };

  private handleCancelForm = () => {
    this.setState({ showForm: false, formErrors: [] });
  };

  private handleTypeChange = (e: Event) => {
    const value = (e.target as HTMLSelectElement).value;
    this.setState({ formType: value, formConfig: {}, formErrors: [] });
  };

  private handleDisplayNameChange = (e: Event) => {
    const value = (e.target as HTMLInputElement).value;
    this.setState({ formDisplayName: value });
  };

  private handleConfigFieldChange = (field: string, value: string) => {
    this.setState((prev) => ({
      formConfig: { ...prev.formConfig, [field]: value },
    }));
  };

  private handleFormSubmit = async (e: Event) => {
    e.preventDefault();
    const { formType, formDisplayName, formConfig } = this.state;

    this.setState({ formSubmitting: true, formErrors: [] });

    // For modem-gateway, generate a pairing secret client-side
    const config = { ...formConfig } as Record<string, string>;
    let generatedSecret: string | undefined;
    if (formType === "modem-gateway") {
      generatedSecret = generatePairingSecret();
      config.pairing_secret = generatedSecret;
    }

    const result = await api.post<{ providerId: string; webhookUrls: string[]; wsEndpoint?: string }>(
      "/api/providers",
      {
        type: formType,
        displayName: formDisplayName,
        config,
      }
    );

    if (result.ok) {
      // Refresh list to get new provider
      await this.fetchProviders();
      this.setState({
        showForm: false,
        formSubmitting: false,
        formDisplayName: "",
        formConfig: {},
        formErrors: [],
      });

      // For modem-gateway, show the pairing secret prominently
      if (formType === "modem-gateway" && generatedSecret) {
        this.setState({
          showPairingSecret: generatedSecret,
          pairingSecretWsEndpoint: result.data.wsEndpoint || null,
        });
      } else {
        this.showNotification("Provider added successfully", "success");
      }
    } else {
      const errorData = result.data as { error?: string; fieldErrors?: FieldError[] };
      this.setState({
        formSubmitting: false,
        formErrors: errorData.fieldErrors || [
          { field: "general", message: errorData.error || "Failed to add provider" },
        ],
      });
    }
  };

  /* ---------- Detail view ---------- */

  private handleProviderClick = (provider: ProviderSummary) => {
    this.fetchProviderDetail(provider.id);
  };

  private handleCloseDetail = () => {
    this.stopStatusPolling();
    this.setState({ selectedProvider: null, modemStatus: null });
  };

  /* ---------- Pairing secret display ---------- */

  private handleDismissPairingSecret = () => {
    this.setState({ showPairingSecret: null, pairingSecretWsEndpoint: null });
    this.showNotification("Provider added successfully", "success");
  };

  /* ---------- Reset pairing ---------- */

  private handleResetPairingClick = (provider: ProviderSummary) => {
    this.setState({ resetTarget: provider, resetSecret: null });
  };

  private handleResetPairingCancel = () => {
    this.setState({ resetTarget: null, resetSecret: null });
  };

  private handleResetPairingConfirm = async () => {
    const { resetTarget } = this.state;
    if (!resetTarget) return;

    this.setState({ resetLoading: true });

    const newSecret = generatePairingSecret();
    const result = await api.post<{ wsEndpoint: string }>(
      `/api/providers/${resetTarget.id}/reset`,
      { pairingSecret: newSecret }
    );

    if (result.ok) {
      this.setState({
        resetTarget: null,
        resetLoading: false,
        showPairingSecret: newSecret,
        pairingSecretWsEndpoint: result.data.wsEndpoint || null,
      });
    } else {
      const errorData = result.data as { error?: string };
      this.setState({ resetTarget: null, resetLoading: false });
      this.showNotification(errorData.error || "Failed to reset pairing", "error");
    }
  };

  /* ---------- Render helpers ---------- */

  private renderNotifications() {
    const { notifications } = this.state;
    return (
      <Fragment>
        {notifications.map((n) => (
          <div
            key={n.id}
            class={`notification ${n.type}`}
            role="alert"
            aria-live="assertive"
          >
            {n.message}
          </div>
        ))}
      </Fragment>
    );
  }

  private renderDeleteDialog() {
    const { deleteTarget, deleteLoading } = this.state;
    if (!deleteTarget) return null;

    return (
      <div class="modal-overlay" role="dialog" aria-modal="true" aria-label="Confirm provider removal">
        <div class="modal-content card">
          <h3>Remove Provider</h3>
          <p>
            Are you sure you want to remove <strong>{deleteTarget.displayName}</strong> ({deleteTarget.type})?
            This action cannot be undone.
          </p>
          <div class="modal-actions">
            <button
              type="button"
              class="btn-secondary"
              onClick={this.handleDeleteCancel}
              disabled={deleteLoading}
            >
              Cancel
            </button>
            <button
              type="button"
              class="btn-danger"
              onClick={this.handleDeleteConfirm}
              disabled={deleteLoading}
              aria-busy={deleteLoading ? "true" : undefined}
            >
              {deleteLoading ? "Removing..." : "Remove"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  private renderPairingSecretDialog() {
    const { showPairingSecret, pairingSecretWsEndpoint } = this.state;
    if (!showPairingSecret) return null;

    return (
      <div class="modal-overlay" role="dialog" aria-modal="true" aria-label="Pairing secret">
        <div class="modal-content card">
          <h3>Modem Gateway Pairing Secret</h3>
          <p>
            Copy this secret into your modem-gateway configuration file under{" "}
            <code>connection.pairingSecret</code>. It will only be shown once.
          </p>
          <div class="pairing-secret-display" aria-label="Pairing secret value">
            <code class="pairing-secret-value">{showPairingSecret}</code>
          </div>
          {pairingSecretWsEndpoint && (
            <p class="form-hint">
              WebSocket endpoint: <code>{pairingSecretWsEndpoint}</code>
            </p>
          )}
          <p class="form-hint">
            The secret expires after 24 hours. If you lose it, use "Reset Pairing" to generate a new one.
          </p>
          <div class="modal-actions">
            <button
              type="button"
              onClick={this.handleDismissPairingSecret}
            >
              I've copied the secret
            </button>
          </div>
        </div>
      </div>
    );
  }

  private renderResetPairingDialog() {
    const { resetTarget, resetLoading } = this.state;
    if (!resetTarget) return null;

    return (
      <div class="modal-overlay" role="dialog" aria-modal="true" aria-label="Confirm pairing reset">
        <div class="modal-content card">
          <h3>Reset Pairing</h3>
          <p>
            This will disconnect <strong>{resetTarget.displayName}</strong>, delete its stored key,
            and generate a new pairing secret. The modem-gateway binary will need to re-pair.
          </p>
          <div class="modal-actions">
            <button
              type="button"
              class="btn-secondary"
              onClick={this.handleResetPairingCancel}
              disabled={resetLoading}
            >
              Cancel
            </button>
            <button
              type="button"
              class="btn-warning"
              onClick={this.handleResetPairingConfirm}
              disabled={resetLoading}
              aria-busy={resetLoading ? "true" : undefined}
            >
              {resetLoading ? "Resetting..." : "Reset Pairing"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  private renderAddForm() {
    const { showForm, formType, formDisplayName, formConfig, formErrors, formSubmitting } =
      this.state;

    if (!showForm) return null;

    const fields = CONFIG_FIELDS[formType] || [];

    const getFieldError = (fieldName: string): string | undefined => {
      const err = formErrors.find(
        (e) => e.field === fieldName || e.field === `config.${fieldName}`
      );
      return err?.message;
    };

    const generalError = formErrors.find((e) => e.field === "general");

    return (
      <form class="card add-provider-form" onSubmit={this.handleFormSubmit} noValidate>
        <h3>Add Provider</h3>

        {generalError && (
          <div class="form-error" role="alert">
            {generalError.message}
          </div>
        )}

        <div class="form-group">
          <label htmlFor="provider-type">Type</label>
          <select
            id="provider-type"
            value={formType}
            onChange={this.handleTypeChange}
            disabled={formSubmitting}
          >
            <option value="vonage">Vonage</option>
            <option value="46elks">46elks</option>
            <option value="modem-gateway">Modem Gateway</option>
            <option value="dummy">Dummy</option>
          </select>
          {getFieldError("type") && (
            <div class="form-error">{getFieldError("type")}</div>
          )}
        </div>

        <div class="form-group">
          <label htmlFor="provider-displayName">Display Name</label>
          <input
            id="provider-displayName"
            type="text"
            value={formDisplayName}
            onInput={this.handleDisplayNameChange}
            maxLength={100}
            placeholder="e.g. My Vonage Account"
            disabled={formSubmitting}
            aria-invalid={getFieldError("displayName") ? "true" : undefined}
          />
          {getFieldError("displayName") && (
            <div class="form-error">{getFieldError("displayName")}</div>
          )}
        </div>

        {fields.map((field) => (
          <div class="form-group" key={field.name}>
            <label htmlFor={`provider-config-${field.name}`}>{field.label}</label>
            {field.type === "textarea" ? (
              <textarea
                id={`provider-config-${field.name}`}
                value={formConfig[field.name] || ""}
                onInput={(e: Event) =>
                  this.handleConfigFieldChange(field.name, (e.target as HTMLTextAreaElement).value)
                }
                disabled={formSubmitting}
                aria-invalid={getFieldError(field.name) ? "true" : undefined}
                rows={6}
                placeholder="-----BEGIN PRIVATE KEY-----&#10;...&#10;-----END PRIVATE KEY-----"
              />
            ) : (
              <input
                id={`provider-config-${field.name}`}
                type={field.type}
                value={formConfig[field.name] || ""}
                onInput={(e: Event) =>
                  this.handleConfigFieldChange(field.name, (e.target as HTMLInputElement).value)
                }
                disabled={formSubmitting}
                aria-invalid={getFieldError(field.name) ? "true" : undefined}
              />
            )}
            {getFieldError(field.name) && (
              <div class="form-error">{getFieldError(field.name)}</div>
            )}
          </div>
        ))}

        <div class="form-actions">
          <button
            type="button"
            class="btn-secondary"
            onClick={this.handleCancelForm}
            disabled={formSubmitting}
          >
            Cancel
          </button>
          <button type="submit" disabled={formSubmitting} aria-busy={formSubmitting ? "true" : undefined}>
            {formSubmitting ? "Adding..." : "Add Provider"}
          </button>
        </div>
      </form>
    );
  }

  private renderEditForm() {
    const { editingProvider, editDisplayName, editConfig, editErrors, editSubmitting } =
      this.state;

    if (!editingProvider) return null;

    const fields = CONFIG_FIELDS[editingProvider.type] || [];

    const getFieldError = (fieldName: string): string | undefined => {
      const err = editErrors.find(
        (e) => e.field === fieldName || e.field === `config.${fieldName}`
      );
      return err?.message;
    };

    const generalError = editErrors.find((e) => e.field === "general");

    return (
      <form class="card edit-provider-form" onSubmit={this.handleEditSubmit} noValidate>
        <h3>Edit Provider: {editingProvider.displayName}</h3>
        <p class="form-hint">
          Leave secret fields empty to keep their current values.
        </p>

        {generalError && (
          <div class="form-error" role="alert">
            {generalError.message}
          </div>
        )}

        <div class="form-group">
          <label htmlFor="edit-provider-displayName">Display Name</label>
          <input
            id="edit-provider-displayName"
            type="text"
            value={editDisplayName}
            onInput={this.handleEditDisplayNameChange}
            maxLength={100}
            disabled={editSubmitting}
            aria-invalid={getFieldError("displayName") ? "true" : undefined}
          />
          {getFieldError("displayName") && (
            <div class="form-error">{getFieldError("displayName")}</div>
          )}
        </div>

        {fields.map((field) => (
          <div class="form-group" key={field.name}>
            <label htmlFor={`edit-provider-config-${field.name}`}>{field.label}</label>
            {field.type === "textarea" ? (
              <textarea
                id={`edit-provider-config-${field.name}`}
                value={editConfig[field.name] || ""}
                onInput={(e: Event) =>
                  this.handleEditConfigFieldChange(field.name, (e.target as HTMLTextAreaElement).value)
                }
                disabled={editSubmitting}
                aria-invalid={getFieldError(field.name) ? "true" : undefined}
                rows={6}
                placeholder={field.type === "textarea" ? "Leave empty to keep current value" : ""}
              />
            ) : (
              <input
                id={`edit-provider-config-${field.name}`}
                type={field.type}
                value={editConfig[field.name] || ""}
                onInput={(e: Event) =>
                  this.handleEditConfigFieldChange(field.name, (e.target as HTMLInputElement).value)
                }
                disabled={editSubmitting}
                aria-invalid={getFieldError(field.name) ? "true" : undefined}
                placeholder={field.type === "password" ? "Leave empty to keep current value" : ""}
              />
            )}
            {getFieldError(field.name) && (
              <div class="form-error">{getFieldError(field.name)}</div>
            )}
          </div>
        ))}

        <div class="form-actions">
          <button
            type="button"
            class="btn-secondary"
            onClick={this.handleEditCancel}
            disabled={editSubmitting}
          >
            Cancel
          </button>
          <button type="submit" disabled={editSubmitting} aria-busy={editSubmitting ? "true" : undefined}>
            {editSubmitting ? "Saving..." : "Save Changes"}
          </button>
        </div>
      </form>
    );
  }

  private renderModemStatus() {
    const { modemStatus, modemStatusLoading } = this.state;

    if (modemStatusLoading && !modemStatus) {
      return (
        <div class="modem-status-section">
          <h4>Modem Status</h4>
          <p class="form-hint">Loading status...</p>
        </div>
      );
    }

    if (!modemStatus) return null;

    const signalBars = modemStatus.signal != null ? Math.min(Math.max(Math.round(modemStatus.signal / 20), 0), 5) : 0;
    const signalLabel = modemStatus.signal != null ? `${modemStatus.signal}%` : "Unknown";

    return (
      <div class="modem-status-section">
        <h4>Modem Status</h4>

        <div class="modem-connection-indicator">
          <span class={`connection-dot ${modemStatus.connected ? "connected" : "disconnected"}`}
                aria-hidden="true" />
          <span class={modemStatus.connected ? "text-connected" : "text-disconnected"}>
            {modemStatus.connected ? "Connected" : "Disconnected"}
          </span>
        </div>

        {modemStatus.connected && (
          <Fragment>
            {modemStatus.modemUnsupportedWarning && (
              <div class="modem-warning" role="alert">
                {modemStatus.modemUnsupportedWarning}
              </div>
            )}

            <div class="modem-signal">
              <span class="signal-bars" aria-label={`Signal strength: ${signalLabel}`}>
                {[1, 2, 3, 4, 5].map((bar) => (
                  <span
                    key={bar}
                    class={`signal-bar ${bar <= signalBars ? "active" : ""}`}
                  />
                ))}
              </span>
              <span class="signal-label">{signalLabel}</span>
            </div>

            <dl class="detail-list modem-detail-list">
              {modemStatus.network && (
                <Fragment>
                  <dt>Network</dt>
                  <dd>{modemStatus.network}</dd>
                </Fragment>
              )}
              {modemStatus.operator && (
                <Fragment>
                  <dt>Operator</dt>
                  <dd>{modemStatus.operator}</dd>
                </Fragment>
              )}
              {modemStatus.modemModel && (
                <Fragment>
                  <dt>Modem</dt>
                  <dd>
                    {modemStatus.modemManufacturer && `${modemStatus.modemManufacturer} `}
                    {modemStatus.modemModel}
                  </dd>
                </Fragment>
              )}
              {modemStatus.firmware && (
                <Fragment>
                  <dt>Firmware</dt>
                  <dd class="monospace">{modemStatus.firmware}</dd>
                </Fragment>
              )}
            </dl>

            {modemStatus.stale && modemStatus.stale.length > 0 && (
              <p class="form-hint modem-stale-warning">
                Stale data: {modemStatus.stale.join(", ")}
              </p>
            )}
          </Fragment>
        )}
      </div>
    );
  }

  private renderProviderDetail() {
    const { selectedProvider, detailLoading } = this.state;

    if (detailLoading) {
      return (
        <div class="card provider-detail">
          <p>Loading provider details...</p>
        </div>
      );
    }

    if (!selectedProvider) return null;

    return (
      <div class="card provider-detail">
        <div class="detail-header">
          <h3>{selectedProvider.displayName}</h3>
          <div class="detail-header-actions">
            <button
              type="button"
              class="btn-sm"
              onClick={() => this.handleEditClick(selectedProvider)}
              aria-label={`Edit ${selectedProvider.displayName}`}
            >
              Edit
            </button>
            <button type="button" class="btn-secondary btn-sm" onClick={this.handleCloseDetail}>
              Close
            </button>
          </div>
        </div>
        <dl class="detail-list">
          <dt>Type</dt>
          <dd>{selectedProvider.type}</dd>
          <dt>Status</dt>
          <dd>{selectedProvider.enabled ? "Enabled" : "Disabled"}</dd>
          <dt>ID</dt>
          <dd class="monospace">{selectedProvider.id}</dd>
        </dl>

        {selectedProvider.type === "modem-gateway" && this.renderModemStatus()}

        {Object.keys(selectedProvider.config).length > 0 && (
          <Fragment>
            <h4>Configuration</h4>
            <dl class="detail-list">
              {Object.entries(selectedProvider.config).map(([key, value]) => (
                <Fragment key={key}>
                  <dt>{key}</dt>
                  <dd class="monospace">{String(value)}</dd>
                </Fragment>
              ))}
            </dl>
          </Fragment>
        )}

        {selectedProvider.webhookUrls.length > 0 && (
          <Fragment>
            <h4>Webhook URLs</h4>
            <ul class="webhook-urls">
              {selectedProvider.webhookUrls.map((url) => (
                <li key={url} class="monospace">
                  {url}
                </li>
              ))}
            </ul>
          </Fragment>
        )}

        {selectedProvider.type === "modem-gateway" && (
          <div class="detail-section">
            <button
              type="button"
              class="btn-warning btn-sm"
              onClick={() => this.handleResetPairingClick(selectedProvider)}
              aria-label={`Reset pairing for ${selectedProvider.displayName}`}
            >
              Reset Pairing
            </button>
          </div>
        )}
      </div>
    );
  }

  private renderProviderList() {
    const { providers, loading } = this.state;

    if (loading) {
      return <p>Loading providers...</p>;
    }

    if (providers.length === 0) {
      return <p class="empty-state">No providers configured. Add one to get started.</p>;
    }

    return (
      <ul class="provider-list" role="list">
        {providers.map((provider) => (
          <li key={provider.id} class="card provider-card">
            <div
              class="provider-info"
              onClick={() => this.handleProviderClick(provider)}
              onKeyDown={(e: KeyboardEvent) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  this.handleProviderClick(provider);
                }
              }}
              role="button"
              tabIndex={0}
              aria-label={`View details for ${provider.displayName}`}
            >
              <span class="provider-name">{provider.displayName}</span>
              <span class="provider-type badge">{provider.type}</span>
              <span class={`provider-status badge ${provider.enabled ? "badge-success" : "badge-muted"}`}>
                {provider.enabled ? "Enabled" : "Disabled"}
              </span>
              {provider.type === "modem-gateway" && provider.connected !== undefined && (
                <span class={`provider-connection badge ${provider.connected ? "badge-connected" : "badge-disconnected"}`}>
                  <span class={`connection-dot-sm ${provider.connected ? "connected" : "disconnected"}`}
                        aria-hidden="true" />
                  {provider.connected ? "Connected" : "Disconnected"}
                </span>
              )}
            </div>
            <div class="provider-actions">
              <button
                type="button"
                class="btn-sm"
                onClick={() => this.handleSync(provider)}
                disabled={this.state.syncingProviderId === provider.id || !provider.enabled}
                aria-label={`Sync numbers for ${provider.displayName}`}
                aria-busy={this.state.syncingProviderId === provider.id ? "true" : undefined}
              >
                {this.state.syncingProviderId === provider.id ? "Syncing..." : "Sync"}
              </button>
              <button
                type="button"
                class={`btn-sm ${provider.enabled ? "btn-warning" : "btn-success-outline"}`}
                onClick={() => this.handleToggleEnabled(provider)}
                aria-label={provider.enabled ? `Disable ${provider.displayName}` : `Enable ${provider.displayName}`}
              >
                {provider.enabled ? "Disable" : "Enable"}
              </button>
              <button
                type="button"
                class="btn-sm btn-danger"
                onClick={() => this.handleDeleteClick(provider)}
                aria-label={`Remove ${provider.displayName}`}
              >
                Remove
              </button>
            </div>
          </li>
        ))}
      </ul>
    );
  }

  render() {
    const { showForm } = this.state;

    return (
      <div class="providers-page">
        <div class="page-header">
          <h2>Providers</h2>
          {!showForm && (
            <button type="button" onClick={this.handleShowForm}>
              Add Provider
            </button>
          )}
        </div>

        {this.renderNotifications()}
        {this.renderPairingSecretDialog()}
        {this.renderResetPairingDialog()}
        {this.renderAddForm()}
        {this.renderEditForm()}
        {this.renderProviderDetail()}
        {this.renderDeleteDialog()}
        {this.renderProviderList()}
      </div>
    );
  }
}
