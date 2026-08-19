// dsh-cordis-mcp — web client face: Settings → dsh-cordis-mcp page.
//
// The MCP endpoint is auth-mandatory, so this page is where the bearer token
// lives: view/copy it into Claude Code's .mcp.json, set your own, or
// regenerate. Reads/writes go through the same-origin /dsh-cordis-mcp/settings
// route (host-owned); the page itself never needs the MCP token.

window.__ModuleLoader__.load({
  id: "dsh-cordis-mcp",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");

    var inject = ["slots"];
    var e = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;

    var SETTINGS_URL = "/dsh-cordis-mcp/settings";

    function getState() {
      return fetch(SETTINGS_URL).then(function (r) { return r.json(); });
    }

    function postAction(payload) {
      return fetch(SETTINGS_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }).then(function (r) { return r.json(); });
    }

    function copyText(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text).then(function () { return true; });
      }
      // Fallback for non-secure contexts.
      try {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand("copy");
        document.body.removeChild(ta);
        return Promise.resolve(ok);
      } catch (err) {
        return Promise.resolve(false);
      }
    }

    // ---------- shared inline styles (theme tokens where available) ----------
    var S = {
      wrap: { display: "flex", flexDirection: "column", gap: 14, maxWidth: 560, padding: "4px 2px 16px" },
      title: { fontSize: 15, fontWeight: 600, color: "var(--dsw-alias-label-primary)" },
      desc: { fontSize: 12.5, lineHeight: 1.6, color: "var(--dsw-alias-label-secondary)" },
      callout: {
        display: "flex", alignItems: "center", gap: 8,
        padding: "8px 12px", borderRadius: 8,
        background: "color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent)",
        color: "var(--dsw-alias-label-primary)", fontSize: 12.5,
      },
      dot: { width: 8, height: 8, borderRadius: 999, background: "var(--dsw-alias-state-warn-primary)", flex: "none" },
      field: { display: "flex", flexDirection: "column", gap: 6 },
      label: { fontSize: 12, fontWeight: 600, color: "var(--dsw-alias-label-primary)" },
      row: { display: "flex", gap: 8, alignItems: "center" },
      input: {
        flex: 1, minWidth: 0, padding: "7px 10px", borderRadius: 8, fontSize: 12.5,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        color: "var(--dsw-alias-label-primary)",
        background: "var(--dsw-alias-bg-layer-1)",
        border: "1px solid var(--dsw-alias-border-l1)",
        outline: "none",
      },
      button: {
        padding: "7px 12px", borderRadius: 8, fontSize: 12.5, cursor: "pointer",
        color: "var(--dsw-alias-label-primary)",
        background: "var(--dsw-alias-bg-layer-1)",
        border: "1px solid var(--dsw-alias-border-l1)",
      },
      buttonPrimary: {
        padding: "7px 14px", borderRadius: 8, fontSize: 12.5, cursor: "pointer",
        color: "#fff",
        background: "var(--dsw-alias-brand-primary)",
        border: "1px solid transparent",
      },
      buttonGhost: {
        padding: "4px 8px", borderRadius: 6, fontSize: 11.5, cursor: "pointer",
        color: "var(--dsw-alias-label-secondary)",
        background: "transparent", border: "1px solid var(--dsw-alias-border-l1)",
      },
      meta: { fontSize: 11.5, color: "var(--dsw-alias-label-secondary)", lineHeight: 1.6 },
      ok: { fontSize: 12, color: "var(--dsw-alias-state-success-primary)" },
      err: { fontSize: 12, color: "var(--dsw-alias-state-error-primary)" },
    };

    function SettingsPage() {
      var state = useState({ phase: "loading" });
      var view = state[0];
      var setView = state[1];

      var draft = useState("");
      var tokenDraft = draft[0];
      var setTokenDraft = draft[1];

      var shown = useState(false);
      var reveal = shown[0];
      var setReveal = shown[1];

      var busyState = useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];

      var note = useState(null);
      var message = note[0];
      var setMessage = note[1];

      function refresh() {
        return getState().then(function (s) {
          setView({ phase: "ok", state: s });
          return s;
        }).catch(function () {
          setView({ phase: "error" });
          return null;
        });
      }

      useEffect(function () {
        refresh();
      }, []);

      function doSave() {
        setBusy(true);
        setMessage(null);
        postAction({ action: "set-token", token: tokenDraft })
          .then(function (s) {
            if (s && s.ok) {
              setMessage({ kind: "ok", text: "已保存，立即生效。" });
              setTokenDraft("");
              setView({ phase: "ok", state: s });
            } else {
              setMessage({ kind: "err", text: (s && s.error) || "保存失败" });
            }
          })
          .catch(function () { setMessage({ kind: "err", text: "保存失败" }); })
          .then(function () { setBusy(false); });
      }

      function doRegenerate() {
        if (!window.confirm("重新生成 token 后，旧 token 立即失效，需要同步更新 Claude Code 的配置。继续？")) return;
        setBusy(true);
        setMessage(null);
        postAction({ action: "regenerate-token" })
          .then(function (s) {
            if (s && s.ok) {
              setMessage({ kind: "ok", text: "已重新生成，立即生效。" });
              setView({ phase: "ok", state: s });
            } else {
              setMessage({ kind: "err", text: (s && s.error) || "生成失败" });
            }
          })
          .catch(function () { setMessage({ kind: "err", text: "生成失败" }); })
          .then(function () { setBusy(false); });
      }

      function doCopyToken() {
        copyText(view.state.token).then(function (ok) {
          setMessage(ok ? { kind: "ok", text: "token 已复制到剪贴板。" } : { kind: "err", text: "复制失败，请手动选择复制。" });
        });
      }

      if (view.phase === "loading") {
        return e("div", { style: S.wrap }, e("div", { style: S.desc }, "加载中…"));
      }
      if (view.phase === "error") {
        return e("div", { style: S.wrap }, e("div", { style: S.err }, "无法读取 dsh-cordis-mcp 配置（host 未加载？）"));
      }

      var s = view.state;
      var endpoint = (location.origin || "http://127.0.0.1") + s.path;

      return e("div", { style: S.wrap },
        e("div", { style: S.title }, "dsh-cordis-mcp"),
        e("div", { style: S.callout },
          e("span", { style: S.dot }),
          e("span", null, "MCP 端点强制身份认证，不能直连。把下面的 token 配到 Claude Code 的 .mcp.json 请求头里。")),

        e("div", { style: S.field },
          e("span", { style: S.label }, "端点地址"),
          e("div", { style: S.row },
            e("input", { style: S.input, readOnly: true, value: endpoint, onFocus: function (ev) { ev.target.select(); } }),
            e("button", { style: S.buttonGhost, onClick: function () { copyText(endpoint).then(function (ok) { setMessage(ok ? { kind: "ok", text: "端点地址已复制。" } : { kind: "err", text: "复制失败" }); }); } }, "复制"))),

        e("div", { style: S.field },
          e("span", { style: S.label }, "认证 token（当前生效）"),
          e("div", { style: S.row },
            e("input", {
              style: S.input,
              type: reveal ? "text" : "password",
              value: s.token || "",
              readOnly: true,
              onFocus: function (ev) { ev.target.select(); },
            }),
            e("button", { style: S.buttonGhost, onClick: function () { setReveal(!reveal); } }, reveal ? "隐藏" : "显示"),
            e("button", { style: S.buttonGhost, onClick: doCopyToken }, "复制"))),

        e("div", { style: S.field },
          e("span", { style: S.label }, "设置自己的 token"),
          e("div", { style: S.row },
            e("input", {
              style: S.input,
              type: reveal ? "text" : "password",
              placeholder: "粘贴或输入新 token（留空并保存 = 清除设置，回落 DSH_MCP_TOKEN / 自动生成）",
              value: tokenDraft,
              onChange: function (ev) { setTokenDraft(ev.target.value); },
            }),
            e("button", { style: S.buttonPrimary, disabled: busy, onClick: doSave }, busy ? "保存中…" : "保存"))),

        e("div", { style: S.row },
          e("button", { style: S.button, disabled: busy, onClick: doRegenerate }, "重新生成 token"),
          message ? e("span", { style: message.kind === "ok" ? S.ok : S.err }, message.text) : null),

        e("div", { style: S.meta },
          "会话解析：显式 sessionId > DSH_MCP_DEFAULT_SESSION > 唯一活会话",
          "　当前活会话：" + (s.sessions && s.sessions.length ? s.sessions.join(", ") : "无"),
          s.defaultSessionId ? "　默认会话：" + s.defaultSessionId : ""),
      );
    }

    function apply(ctx) {
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register(
          { name: "settings.section", id: "dsh-cordis-mcp", order: 90, label: "dsh-cordis-mcp" },
          function () {
            return e(SettingsPage, null);
          },
        );
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
