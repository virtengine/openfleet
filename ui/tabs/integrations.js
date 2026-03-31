/* ─────────────────────────────────────────────────────────────
 *  Tab: Integrations / Vault — Manage secrets, integrations, env vars
 * ────────────────────────────────────────────────────────────── */
import { h } from "preact";
import { useState, useEffect, useCallback } from "preact/hooks";
import htm from "htm";
const html = htm.bind(h);
import { apiFetch } from "../modules/api.js";
import { showToast } from "../modules/state.js";

/* ── Styles ─────────────────────────────────────────────────── */

const S = {
  page: {
    padding: "16px",
    maxWidth: "1200px",
    margin: "0 auto",
  },
  twoCol: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "24px",
    alignItems: "start",
  },
  oneCol: {
    display: "grid",
    gridTemplateColumns: "1fr",
    gap: "24px",
  },
  sectionTitle: {
    fontSize: "13px",
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    color: "var(--tg-theme-hint-color, #888)",
    marginBottom: "12px",
  },
  card: {
    background: "var(--tg-theme-secondary-bg-color, #1e1e1e)",
    borderRadius: "12px",
    padding: "14px",
    marginBottom: "10px",
    display: "flex",
    alignItems: "flex-start",
    gap: "12px",
  },
  cardIcon: {
    fontSize: "24px",
    lineHeight: 1,
    flexShrink: 0,
    width: "36px",
    textAlign: "center",
  },
  cardBody: { flex: 1, minWidth: 0 },
  cardName: {
    fontWeight: 600,
    fontSize: "14px",
    marginBottom: "2px",
  },
  cardDesc: {
    fontSize: "12px",
    color: "var(--tg-theme-hint-color, #888)",
    marginBottom: "6px",
  },
  btnRow: { display: "flex", gap: "6px", flexWrap: "wrap", marginTop: "6px" },
  btn: {
    padding: "5px 12px",
    borderRadius: "8px",
    border: "none",
    cursor: "pointer",
    fontSize: "12px",
    fontWeight: 500,
    background: "var(--tg-theme-button-color, #3390ec)",
    color: "var(--tg-theme-button-text-color, #fff)",
  },
  btnDanger: {
    padding: "5px 12px",
    borderRadius: "8px",
    border: "none",
    cursor: "pointer",
    fontSize: "12px",
    fontWeight: 500,
    background: "rgba(255,80,80,0.18)",
    color: "#ff5050",
  },
  btnGhost: {
    padding: "5px 12px",
    borderRadius: "8px",
    border: "1px solid var(--tg-theme-hint-color, #555)",
    cursor: "pointer",
    fontSize: "12px",
    fontWeight: 500,
    background: "transparent",
    color: "var(--tg-theme-text-color, #eee)",
  },
  chip: {
    display: "inline-block",
    background: "rgba(51,144,236,0.15)",
    color: "#3390ec",
    borderRadius: "6px",
    padding: "2px 7px",
    fontSize: "11px",
    marginRight: "4px",
  },
  emptyHint: {
    textAlign: "center",
    color: "var(--tg-theme-hint-color, #888)",
    fontSize: "13px",
    padding: "24px 0",
  },
  /* Modal overlay */
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.6)",
    zIndex: 1000,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "16px",
  },
  modal: {
    background: "var(--tg-theme-bg-color, #181818)",
    borderRadius: "14px",
    padding: "20px",
    width: "100%",
    maxWidth: "420px",
    maxHeight: "85vh",
    overflowY: "auto",
  },
  modalTitle: {
    fontSize: "16px",
    fontWeight: 700,
    marginBottom: "16px",
    display: "flex",
    alignItems: "center",
    gap: "8px",
  },
  formGroup: { marginBottom: "12px" },
  label: {
    display: "block",
    fontSize: "12px",
    fontWeight: 500,
    marginBottom: "4px",
    color: "var(--tg-theme-hint-color, #aaa)",
  },
  input: {
    width: "100%",
    boxSizing: "border-box",
    padding: "8px 10px",
    borderRadius: "8px",
    border: "1px solid var(--tg-theme-hint-color, #444)",
    background: "var(--tg-theme-secondary-bg-color, #1e1e1e)",
    color: "var(--tg-theme-text-color, #eee)",
    fontSize: "13px",
  },
  helpText: {
    fontSize: "11px",
    color: "var(--tg-theme-hint-color, #888)",
    marginTop: "3px",
  },
  /* Init vault panel */
  initPanel: {
    textAlign: "center",
    padding: "40px 20px",
    maxWidth: "400px",
    margin: "0 auto",
  },
  initIcon: { fontSize: "48px", marginBottom: "12px" },
  initTitle: { fontSize: "20px", fontWeight: 700, marginBottom: "8px" },
  initDesc: {
    fontSize: "13px",
    color: "var(--tg-theme-hint-color, #888)",
    marginBottom: "20px",
  },
  /* Collapsible env section */
  collapsibleHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    cursor: "pointer",
    padding: "8px 0",
    userSelect: "none",
  },
  permsPanel: {
    background: "var(--tg-theme-secondary-bg-color, #1e1e1e)",
    borderRadius: "8px",
    padding: "10px 12px",
    fontSize: "12px",
    marginTop: "6px",
  },
};

/* ── Vault Init Panel ───────────────────────────────────────── */

function VaultInitPanel({ onInitialized }) {
  const [loading, setLoading] = useState(false);

  async function handleInit() {
    setLoading(true);
    const { ok, error } = await apiFetch("/api/vault/init", { method: "POST" });
    setLoading(false);
    if (ok) {
      showToast("Vault initialized", "success");
      onInitialized();
    } else {
      showToast(error || "Failed to initialize vault", "error");
    }
  }

  return html`
    <div style=${S.initPanel}>
      <div style=${S.initIcon}>🔐</div>
      <div style=${S.initTitle}>Initialize Vault</div>
      <p style=${S.initDesc}>
        The Vault securely stores secrets and credentials used by your agents
        and workflows. Initialize it to get started.
      </p>
      <button style=${S.btn} onClick=${handleInit} disabled=${loading}>
        ${loading ? "Initializing…" : "Initialize Vault"}
      </button>
    </div>
  `;
}

/* ── Permissions Panel ──────────────────────────────────────── */

function PermissionsPanel({ permissions }) {
  const agents = permissions?.agents ?? [];
  const workflows = permissions?.workflows ?? [];
  const fmt = (arr) =>
    arr.length === 0
      ? html`<em style="color:var(--tg-theme-hint-color,#888)">none</em>`
      : arr.map((v) => html`<span style=${S.chip}>${v}</span>`);

  return html`
    <div style=${S.permsPanel}>
      <div style=${{ marginBottom: "6px" }}>
        <strong>Agents:</strong>${" "}${fmt(agents)}
        ${agents.includes("*")
          ? html`<span style=${{ fontSize: "11px", color: "var(--tg-theme-hint-color,#888)" }}> (all agents)</span>`
          : ""}
      </div>
      <div>
        <strong>Workflows:</strong>${" "}${fmt(workflows)}
        ${workflows.includes("*")
          ? html`<span style=${{ fontSize: "11px", color: "var(--tg-theme-hint-color,#888)" }}> (all workflows)</span>`
          : ""}
      </div>
    </div>
  `;
}

/* ── Add Secret Modal ───────────────────────────────────────── */

function AddSecretModal({ integration, onClose, onSaved }) {
  const [name, setName] = useState("");
  const [label, setLabel] = useState("");
  const [fieldValues, setFieldValues] = useState({});
  const [saving, setSaving] = useState(false);

  function setField(id, value) {
    setFieldValues((prev) => ({ ...prev, [id]: value }));
  }

  async function handleSave() {
    if (!name.trim()) {
      showToast("Name is required", "error");
      return;
    }
    setSaving(true);
    const { ok, error } = await apiFetch("/api/vault/secrets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: name.trim(),
        integration: integration.id,
        label: label.trim() || undefined,
        fields: fieldValues,
      }),
    });
    setSaving(false);
    if (ok) {
      showToast("Secret saved", "success");
      onSaved();
    } else {
      showToast(error || "Failed to save secret", "error");
    }
  }

  function inputType(fieldType) {
    if (fieldType === "password") return "password";
    if (fieldType === "url") return "url";
    return "text";
  }

  return html`
    <div style=${S.overlay} onClick=${(e) => e.target === e.currentTarget && onClose()}>
      <div style=${S.modal}>
        <div style=${S.modalTitle}>
          <span>${integration.icon || "🔑"}</span>
          <span>Add ${integration.name}</span>
        </div>

        <div style=${S.formGroup}>
          <label style=${S.label}>Name *</label>
          <input
            style=${S.input}
            type="text"
            value=${name}
            placeholder="e.g. my-github-token"
            onInput=${(e) => setName(e.target.value)}
          />
        </div>

        <div style=${S.formGroup}>
          <label style=${S.label}>Label (optional)</label>
          <input
            style=${S.input}
            type="text"
            value=${label}
            placeholder="Human-friendly label"
            onInput=${(e) => setLabel(e.target.value)}
          />
        </div>

        ${(integration.fields || []).map(
          (field) => html`
            <div style=${S.formGroup} key=${field.id}>
              <label style=${S.label}>
                ${field.label}${field.required ? " *" : ""}
              </label>
              <input
                style=${S.input}
                type=${inputType(field.type)}
                value=${fieldValues[field.id] || ""}
                placeholder=${field.placeholder || ""}
                onInput=${(e) => setField(field.id, e.target.value)}
              />
              ${field.helpText
                ? html`<div style=${S.helpText}>${field.helpText}</div>`
                : ""}
            </div>
          `
        )}

        <div style=${{ ...S.btnRow, marginTop: "16px" }}>
          <button style=${S.btn} onClick=${handleSave} disabled=${saving}>
            ${saving ? "Saving…" : "Save Secret"}
          </button>
          <button style=${S.btnGhost} onClick=${onClose}>Cancel</button>
        </div>
      </div>
    </div>
  `;
}

/* ── Add Env Var Modal ──────────────────────────────────────── */

function AddEnvModal({ onClose, onSaved }) {
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    if (!key.trim()) {
      showToast("Key is required", "error");
      return;
    }
    setSaving(true);
    const { ok, error } = await apiFetch("/api/vault/env", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: key.trim(), value }),
    });
    setSaving(false);
    if (ok) {
      showToast("Env var saved", "success");
      onSaved();
    } else {
      showToast(error || "Failed to save env var", "error");
    }
  }

  return html`
    <div style=${S.overlay} onClick=${(e) => e.target === e.currentTarget && onClose()}>
      <div style=${S.modal}>
        <div style=${S.modalTitle}>
          <span>📝</span>
          <span>Add Environment Variable</span>
        </div>

        <div style=${S.formGroup}>
          <label style=${S.label}>Key *</label>
          <input
            style=${S.input}
            type="text"
            value=${key}
            placeholder="MY_VAR_NAME"
            onInput=${(e) => setKey(e.target.value)}
          />
        </div>

        <div style=${S.formGroup}>
          <label style=${S.label}>Value</label>
          <input
            style=${S.input}
            type="password"
            value=${value}
            placeholder="secret value"
            onInput=${(e) => setValue(e.target.value)}
          />
        </div>

        <div style=${{ ...S.btnRow, marginTop: "16px" }}>
          <button style=${S.btn} onClick=${handleSave} disabled=${saving}>
            ${saving ? "Saving…" : "Add Variable"}
          </button>
          <button style=${S.btnGhost} onClick=${onClose}>Cancel</button>
        </div>
      </div>
    </div>
  `;
}

/* ── Integration Card ───────────────────────────────────────── */

function IntegrationCard({ integration, onAdd }) {
  return html`
    <div style=${S.card}>
      <div style=${S.cardIcon}>${integration.icon || "🔌"}</div>
      <div style=${S.cardBody}>
        <div style=${S.cardName}>${integration.name}</div>
        <div style=${S.cardDesc}>${integration.description || ""}</div>
        <button style=${S.btn} onClick=${() => onAdd(integration)}>
          + Add
        </button>
      </div>
    </div>
  `;
}

/* ── Secret Card ────────────────────────────────────────────── */

function SecretCard({ secret, integrations, onDelete, onRefresh }) {
  const [showPerms, setShowPerms] = useState(false);
  const integration = integrations.find((i) => i.id === secret.integration);

  async function handleDelete() {
    if (!confirm(`Delete secret "${secret.name}"?`)) return;
    const { ok, error } = await apiFetch(`/api/vault/secrets/${secret.id}`, {
      method: "DELETE",
    });
    if (ok) {
      showToast("Secret deleted", "success");
      onDelete(secret.id);
    } else {
      showToast(error || "Failed to delete", "error");
    }
  }

  return html`
    <div style=${S.card}>
      <div style=${S.cardIcon}>${integration?.icon || "🔑"}</div>
      <div style=${S.cardBody}>
        <div style=${S.cardName}>${secret.name}</div>
        <div style=${S.cardDesc}>
          ${secret.label ? html`<span>${secret.label} · </span>` : ""}
          <span style=${S.chip}>${secret.integration || "unknown"}</span>
        </div>
        <div style=${S.btnRow}>
          <button
            style=${S.btnGhost}
            onClick=${() => setShowPerms((v) => !v)}
          >
            🔒 Permissions
          </button>
          <button style=${S.btnDanger} onClick=${handleDelete}>
            Delete
          </button>
        </div>
        ${showPerms
          ? html`<${PermissionsPanel} permissions=${secret.permissions} />`
          : ""}
      </div>
    </div>
  `;
}

/* ── Env Vars Section ───────────────────────────────────────── */

function EnvVarsSection() {
  const [open, setOpen] = useState(false);
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showModal, setShowModal] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { ok, data } = await apiFetch("/api/vault/env");
    setLoading(false);
    if (ok) setKeys(data?.keys || []);
  }, []);

  useEffect(() => {
    if (open && keys.length === 0) load();
  }, [open, keys.length, load]);

  async function handleDelete(key) {
    if (!confirm(`Delete env var "${key}"?`)) return;
    const { ok, error } = await apiFetch(
      `/api/vault/env/${encodeURIComponent(key)}`,
      { method: "DELETE" }
    );
    if (ok) {
      showToast(`Deleted ${key}`, "success");
      setKeys((prev) => prev.filter((k) => k !== key));
    } else {
      showToast(error || "Failed to delete", "error");
    }
  }

  return html`
    <div style=${{ marginTop: "20px" }}>
      <div
        style=${S.collapsibleHeader}
        onClick=${() => setOpen((v) => !v)}
        role="button"
        tabIndex="0"
        onKeyDown=${(e) => e.key === "Enter" && setOpen((v) => !v)}
      >
        <span style=${S.sectionTitle} style=${{ marginBottom: 0 }}>
          📋 Environment Variables
        </span>
        <span style=${{ fontSize: "18px" }}>${open ? "▾" : "▸"}</span>
      </div>

      ${open
        ? html`
            <div>
              <div style=${{ ...S.btnRow, marginBottom: "10px" }}>
                <button style=${S.btn} onClick=${() => setShowModal(true)}>
                  + Add Env Var
                </button>
                <button style=${S.btnGhost} onClick=${load}>
                  Refresh
                </button>
              </div>

              ${loading
                ? html`<div style=${S.emptyHint}>Loading…</div>`
                : keys.length === 0
                  ? html`<div style=${S.emptyHint}>No environment variables stored</div>`
                  : keys.map(
                      (k) => html`
                        <div
                          style=${{ ...S.card, marginBottom: "6px" }}
                          key=${k}
                        >
                          <div style=${S.cardIcon}>🔑</div>
                          <div style=${S.cardBody}>
                            <div style=${S.cardName}>${k}</div>
                            <div style=${S.cardDesc}>
                              value hidden for security
                            </div>
                          </div>
                          <button
                            style=${S.btnDanger}
                            onClick=${() => handleDelete(k)}
                          >
                            Delete
                          </button>
                        </div>
                      `
                    )}
            </div>
          `
        : ""}

      ${showModal
        ? html`
            <${AddEnvModal}
              onClose=${() => setShowModal(false)}
              onSaved=${() => {
                setShowModal(false);
                load();
              }}
            />
          `
        : ""}
    </div>
  `;
}

/* ── Main Tab ───────────────────────────────────────────────── */

export function IntegrationsTab() {
  const [vaultReady, setVaultReady] = useState(null); // null=loading, false=uninit, true=ready
  const [integrations, setIntegrations] = useState([]);
  const [secrets, setSecrets] = useState([]);
  const [addTarget, setAddTarget] = useState(null); // integration to add secret for
  const [narrow, setNarrow] = useState(false);

  // Responsive: detect narrow viewport
  useEffect(() => {
    function check() {
      setNarrow(window.innerWidth < 720);
    }
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  const loadStatus = useCallback(async () => {
    const { ok, data } = await apiFetch("/api/vault/status");
    if (!ok) {
      setVaultReady(false);
      return;
    }
    if (data?.initialized === false) {
      setVaultReady(false);
    } else {
      setVaultReady(true);
    }
  }, []);

  const loadIntegrations = useCallback(async () => {
    const { ok, data } = await apiFetch("/api/vault/integrations");
    if (ok) setIntegrations(data || []);
  }, []);

  const loadSecrets = useCallback(async () => {
    const { ok, data } = await apiFetch("/api/vault/secrets");
    if (ok) setSecrets(data || []);
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (vaultReady) {
      loadIntegrations();
      loadSecrets();
    }
  }, [vaultReady, loadIntegrations, loadSecrets]);

  if (vaultReady === null) {
    return html`<div style=${S.page}><div style=${S.emptyHint}>Loading vault…</div></div>`;
  }

  if (vaultReady === false) {
    return html`
      <div style=${S.page}>
        <${VaultInitPanel} onInitialized=${loadStatus} />
      </div>
    `;
  }

  return html`
    <div style=${S.page}>
      <div style=${narrow ? S.oneCol : S.twoCol}>
        <!-- Left: Available Integrations -->
        <div>
          <div style=${S.sectionTitle}>Available Integrations</div>
          ${integrations.length === 0
            ? html`<div style=${S.emptyHint}>No integrations available</div>`
            : integrations.map(
                (i) => html`
                  <${IntegrationCard}
                    key=${i.id}
                    integration=${i}
                    onAdd=${setAddTarget}
                  />
                `
              )}
        </div>

        <!-- Right: Saved Secrets -->
        <div>
          <div style=${S.sectionTitle}>Saved Secrets</div>
          ${secrets.length === 0
            ? html`<div style=${S.emptyHint}>No secrets saved yet</div>`
            : secrets.map(
                (s) => html`
                  <${SecretCard}
                    key=${s.id}
                    secret=${s}
                    integrations=${integrations}
                    onDelete=${(id) =>
                      setSecrets((prev) => prev.filter((x) => x.id !== id))}
                    onRefresh=${loadSecrets}
                  />
                `
              )}

          <${EnvVarsSection} />
        </div>
      </div>

      ${addTarget
        ? html`
            <${AddSecretModal}
              integration=${addTarget}
              onClose=${() => setAddTarget(null)}
              onSaved=${() => {
                setAddTarget(null);
                loadSecrets();
              }}
            />
          `
        : ""}
    </div>
  `;
}
