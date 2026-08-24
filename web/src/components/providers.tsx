import { h, Component, Fragment } from "preact";
import { api } from "../api";

/* ---------- Types ---------- */

interface ProviderSummary {
  id: string;
  type: string;
  displayName: string;
  enabled: boolean;
}

interface ProviderDetail extends ProviderSummary {
  config: Record<string, unknown>;
  webhookUrls: string[];
}

interface FieldError {
  field: string;
  message: string;
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
};

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

  // Edit form state
  editingProvider: ProviderDetail | null;
  editDisplayName: string;
  editConfig: Record<string, string>;
  editErrors: FieldError[];
  editSubmitting: boolean;

  // Delete confirmation
  deleteTarget: ProviderSummary | null;
  deleteLoading: boolean;

  // Sync state
  syncingProviderId: string | null;

  // Notifications
  notifications: Notification[];
}

let notificationCounter = 0;

/* ---------- Component ---------- */

export class Providers extends Component<Record<string, never>, ProvidersState> {
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
    editingProvider: null,
    editDisplayName: "",
    editConfig: {},
    editErrors: [],
    editSubmitting: false,
    deleteTarget: null,
    deleteLoading: false,
    syncingProviderId: null,
    notifications: [],
  };

  componentDidMount() {
    this.fetchProviders();
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
    this.setState({ detailLoading: true });
    const result = await api.get<ProviderDetail>(`/api/providers/${id}`);
    if (result.ok) {
      this.setState({ selectedProvider: result.data, detailLoading: false });
    } else {
      this.setState({ detailLoading: false });
      this.showNotification("Failed to load provider details", "error");
    }
  };

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

    const result = await api.post<{ providerId: string; webhookUrls: string[] }>(
      "/api/providers",
      {
        type: formType,
        displayName: formDisplayName,
        config: formConfig,
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
      this.showNotification("Provider added successfully", "success");
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
    this.setState({ selectedProvider: null });
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
        {this.renderAddForm()}
        {this.renderEditForm()}
        {this.renderProviderDetail()}
        {this.renderDeleteDialog()}
        {this.renderProviderList()}
      </div>
    );
  }
}
