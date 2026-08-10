import { h, Component } from "preact";
import { api } from "../api";

interface NumberEntry {
  number: string;
  label: string | null;
  addedAt: string;
  isActive: boolean;
  lastUsedAt: string | null;
  providerId: string;
  providerDisplayName: string | null;
  blockInboundCalls: boolean;
  color: string;
}

interface NumbersResponse {
  numbers: NumberEntry[];
  defaultNumber: string | null;
}

interface ProviderGroup {
  providerId: string;
  providerName: string;
  numbers: NumberEntry[];
}

interface NumbersState {
  groups: ProviderGroup[];
  loading: boolean;
  error: string;
  editingNumber: string | null;
  editLabel: string;
  editError: string;
  editSaving: boolean;
  confirmNumber: string | null;
  confirmAction: "activate" | "deactivate" | null;
  confirmLoading: boolean;
  blockInboundSaving: string | null;
  defaultNumber: string | null;
  defaultSaving: boolean;
}

export class Numbers extends Component<Record<string, never>, NumbersState> {
  state: NumbersState = {
    groups: [],
    loading: true,
    error: "",
    editingNumber: null,
    editLabel: "",
    editError: "",
    editSaving: false,
    confirmNumber: null,
    confirmAction: null,
    confirmLoading: false,
    blockInboundSaving: null,
    defaultNumber: null,
    defaultSaving: false,
  };

  componentDidMount() {
    this.fetchNumbers();
  }

  private async fetchNumbers() {
    this.setState({ loading: true, error: "" });

    const result = await api.get<NumbersResponse>("/api/numbers");

    if (!result.ok) {
      this.setState({
        loading: false,
        error: result.data?.error || "Failed to load numbers",
      });
      return;
    }

    const groups = this.groupByProvider(result.data.numbers);
    this.setState({ groups, loading: false, defaultNumber: result.data.defaultNumber });
  }

  private groupByProvider(numbers: NumberEntry[]): ProviderGroup[] {
    const map = new Map<string, ProviderGroup>();

    for (const num of numbers) {
      const existing = map.get(num.providerId);
      if (existing) {
        existing.numbers.push(num);
      } else {
        map.set(num.providerId, {
          providerId: num.providerId,
          providerName: num.providerDisplayName || num.providerId,
          numbers: [num],
        });
      }
    }

    return Array.from(map.values());
  }

  private startEditing = (num: NumberEntry) => {
    this.setState({
      editingNumber: num.number,
      editLabel: num.label || "",
      editError: "",
      editSaving: false,
    });
  };

  private cancelEditing = () => {
    this.setState({
      editingNumber: null,
      editLabel: "",
      editError: "",
      editSaving: false,
    });
  };

  private handleLabelChange = (e: Event) => {
    const target = e.target as HTMLInputElement;
    this.setState({ editLabel: target.value, editError: "" });
  };

  private saveLabel = async () => {
    const { editingNumber, editLabel } = this.state;
    if (!editingNumber) return;

    if (editLabel.length < 1 || editLabel.length > 30) {
      this.setState({ editError: "Label must be between 1 and 30 characters" });
      return;
    }

    this.setState({ editSaving: true, editError: "" });

    const result = await api.put<{ message: string }>(
      `/api/numbers/${encodeURIComponent(editingNumber)}/label`,
      { label: editLabel }
    );

    if (!result.ok) {
      const errorData = result.data as { error?: string; details?: string[] };
      const errorMsg =
        errorData.details?.join(", ") || errorData.error || "Failed to update label";
      this.setState({ editSaving: false, editError: errorMsg });
      return;
    }

    this.setState({
      editingNumber: null,
      editLabel: "",
      editError: "",
      editSaving: false,
    });

    await this.fetchNumbers();
  };

  private showConfirmation = (number: string, action: "activate" | "deactivate") => {
    this.setState({
      confirmNumber: number,
      confirmAction: action,
      confirmLoading: false,
    });
  };

  private cancelConfirmation = () => {
    this.setState({
      confirmNumber: null,
      confirmAction: null,
      confirmLoading: false,
    });
  };

  private confirmStatusChange = async () => {
    const { confirmNumber, confirmAction } = this.state;
    if (!confirmNumber || !confirmAction) return;

    this.setState({ confirmLoading: true });

    const active = confirmAction === "activate";
    const result = await api.put<{ message: string }>(
      `/api/numbers/${encodeURIComponent(confirmNumber)}/active`,
      { active }
    );

    if (!result.ok) {
      this.setState({ confirmLoading: false });
      const errorData = result.data as { error?: string };
      this.setState({
        error: errorData.error || `Failed to ${confirmAction} number`,
        confirmNumber: null,
        confirmAction: null,
        confirmLoading: false,
      });
      return;
    }

    this.setState({
      confirmNumber: null,
      confirmAction: null,
      confirmLoading: false,
    });

    await this.fetchNumbers();
  };

  private handleLabelKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      this.saveLabel();
    } else if (e.key === "Escape") {
      this.cancelEditing();
    }
  };

  private toggleBlockInbound = async (num: NumberEntry) => {
    const newValue = !num.blockInboundCalls;
    this.setState({ blockInboundSaving: num.number });

    const result = await api.put<{ message: string }>(
      `/api/numbers/${encodeURIComponent(num.number)}/block-inbound`,
      { block: newValue }
    );

    this.setState({ blockInboundSaving: null });

    if (!result.ok) {
      const errorData = result.data as { error?: string };
      this.setState({
        error: errorData.error || "Failed to update block inbound calls setting",
      });
      return;
    }

    await this.fetchNumbers();
  };

  private setAsDefault = async (num: NumberEntry) => {
    this.setState({ defaultSaving: true });

    const result = await api.put<{ message: string; defaultNumber: string | null }>(
      "/api/numbers/default",
      { number: num.number }
    );

    this.setState({ defaultSaving: false });

    if (!result.ok) {
      const errorData = result.data as { error?: string };
      this.setState({
        error: errorData.error || "Failed to set default number",
      });
      return;
    }

    this.setState({ defaultNumber: num.number });
  };

  private clearDefault = async () => {
    this.setState({ defaultSaving: true });

    const result = await api.put<{ message: string; defaultNumber: string | null }>(
      "/api/numbers/default",
      { number: null }
    );

    this.setState({ defaultSaving: false });

    if (!result.ok) {
      const errorData = result.data as { error?: string };
      this.setState({
        error: errorData.error || "Failed to clear default number",
      });
      return;
    }

    this.setState({ defaultNumber: null });
  };

  render() {
    const {
      groups,
      loading,
      error,
      editingNumber,
      editLabel,
      editError,
      editSaving,
      confirmNumber,
      confirmAction,
      confirmLoading,
    } = this.state;

    if (loading) {
      return (
        <div class="numbers-container" role="main">
          <h1>Numbers</h1>
          <p class="loading-text" aria-live="polite">Loading numbers...</p>
        </div>
      );
    }

    return (
      <div class="numbers-container" role="main">
        <h1>Numbers</h1>

        {error && (
          <div class="numbers-error" role="alert" aria-live="assertive">
            {error}
          </div>
        )}

        {groups.length === 0 && !error && (
          <p class="numbers-empty">No numbers configured.</p>
        )}

        {groups.map((group) => (
          <section
            key={group.providerId}
            class="numbers-provider-group"
            aria-labelledby={`provider-${group.providerId}`}
          >
            <h2 id={`provider-${group.providerId}`} class="provider-group-title">
              {group.providerName}
            </h2>

            <ul class="numbers-list" role="list">
              {group.numbers.map((num) => (
                <li key={num.number} class="number-item">
                  <div class="number-info">
                    <span class="number-value">
                      <span
                        class="number-color-dot"
                        style={{ backgroundColor: num.color || "#6750A4" }}
                      />
                      {num.number}
                    </span>
                    <span class={`number-status ${num.isActive ? "active" : "inactive"}`}>
                      {num.isActive ? "Active" : "Inactive"}
                    </span>
                    {this.state.defaultNumber === num.number && (
                      <span class="number-status default">Default</span>
                    )}
                    <span class="number-capabilities">SMS, Voice</span>
                  </div>

                  <div class="number-label-section">
                    {editingNumber === num.number ? (
                      <div class="label-edit" role="form" aria-label={`Edit label for ${num.number}`}>
                        <input
                          type="text"
                          value={editLabel}
                          onInput={this.handleLabelChange}
                          onKeyDown={this.handleLabelKeyDown}
                          maxLength={30}
                          minLength={1}
                          disabled={editSaving}
                          aria-label="Number label"
                          aria-describedby={editError ? "label-edit-error" : undefined}
                          aria-invalid={editError ? "true" : undefined}
                          class="label-input"
                          autoFocus
                        />
                        <span class="label-char-count">
                          {editLabel.length}/30
                        </span>
                        <button
                          type="button"
                          onClick={this.saveLabel}
                          disabled={editSaving || editLabel.length === 0}
                          class="btn btn-save"
                          aria-busy={editSaving ? "true" : undefined}
                        >
                          {editSaving ? "Saving..." : "Save"}
                        </button>
                        <button
                          type="button"
                          onClick={this.cancelEditing}
                          disabled={editSaving}
                          class="btn btn-cancel"
                        >
                          Cancel
                        </button>
                        {editError && (
                          <div id="label-edit-error" class="label-error" role="alert">
                            {editError}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div class="label-display">
                        <span class="label-text">
                          {num.label || <em class="no-label">No label</em>}
                        </span>
                        <button
                          type="button"
                          onClick={() => this.startEditing(num)}
                          class="btn btn-edit"
                          aria-label={`Edit label for ${num.number}`}
                        >
                          Edit
                        </button>
                      </div>
                    )}
                  </div>

                  <div class="number-actions">
                    <label class="block-inbound-toggle">
                      <input
                        type="checkbox"
                        checked={num.blockInboundCalls}
                        disabled={this.state.blockInboundSaving === num.number}
                        onChange={() => this.toggleBlockInbound(num)}
                        aria-label={`Block incoming calls for ${num.number}`}
                      />
                      <span class="toggle-label">
                        Block incoming calls
                      </span>
                    </label>
                    {num.isActive && (
                      this.state.defaultNumber === num.number ? (
                        <button
                          type="button"
                          onClick={this.clearDefault}
                          disabled={this.state.defaultSaving}
                          class="btn btn-default-clear"
                          aria-label={`Clear ${num.number} as default number`}
                        >
                          {this.state.defaultSaving ? "Saving..." : "Clear default"}
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => this.setAsDefault(num)}
                          disabled={this.state.defaultSaving}
                          class="btn btn-default-set"
                          aria-label={`Set ${num.number} as default number`}
                        >
                          {this.state.defaultSaving ? "Saving..." : "Set as default"}
                        </button>
                      )
                    )}
                    {num.isActive ? (
                      <button
                        type="button"
                        onClick={() => this.showConfirmation(num.number, "deactivate")}
                        class="btn btn-deactivate"
                        aria-label={`Deactivate ${num.number}`}
                      >
                        Deactivate
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => this.showConfirmation(num.number, "activate")}
                        class="btn btn-activate"
                        aria-label={`Activate ${num.number}`}
                      >
                        Activate
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}

        {confirmNumber && confirmAction && (
          <div
            class="confirmation-overlay"
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
          >
            <div class="confirmation-dialog">
              <h3 id="confirm-title">
                {confirmAction === "deactivate" ? "Deactivate Number" : "Activate Number"}
              </h3>
              <p>
                Are you sure you want to {confirmAction} <strong>{confirmNumber}</strong>?
              </p>
              <div class="confirmation-actions">
                <button
                  type="button"
                  onClick={this.confirmStatusChange}
                  disabled={confirmLoading}
                  class={`btn ${confirmAction === "deactivate" ? "btn-danger" : "btn-primary"}`}
                  aria-busy={confirmLoading ? "true" : undefined}
                >
                  {confirmLoading
                    ? "Processing..."
                    : confirmAction === "deactivate"
                      ? "Deactivate"
                      : "Activate"}
                </button>
                <button
                  type="button"
                  onClick={this.cancelConfirmation}
                  disabled={confirmLoading}
                  class="btn btn-cancel"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }
}
