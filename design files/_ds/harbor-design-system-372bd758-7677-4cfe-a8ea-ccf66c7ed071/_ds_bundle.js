/* @ds-bundle: {"format":3,"namespace":"HarborDesignSystem_372bd7","components":[{"name":"Avatar","sourcePath":"components/core/Avatar.jsx"},{"name":"Badge","sourcePath":"components/core/Badge.jsx"},{"name":"Button","sourcePath":"components/core/Button.jsx"},{"name":"Card","sourcePath":"components/core/Card.jsx"},{"name":"IconButton","sourcePath":"components/core/IconButton.jsx"},{"name":"Tag","sourcePath":"components/core/Tag.jsx"},{"name":"Toast","sourcePath":"components/feedback/Toast.jsx"},{"name":"Tooltip","sourcePath":"components/feedback/Tooltip.jsx"},{"name":"Checkbox","sourcePath":"components/forms/Checkbox.jsx"},{"name":"Input","sourcePath":"components/forms/Input.jsx"},{"name":"Select","sourcePath":"components/forms/Select.jsx"},{"name":"Switch","sourcePath":"components/forms/Switch.jsx"},{"name":"Tabs","sourcePath":"components/navigation/Tabs.jsx"}],"sourceHashes":{"components/core/Avatar.jsx":"43262d33a344","components/core/Badge.jsx":"ed55a9b136d2","components/core/Button.jsx":"e74d9fbfd9f5","components/core/Card.jsx":"2e509a43862b","components/core/IconButton.jsx":"929ecdfa9f3b","components/core/Tag.jsx":"f44df66f11ea","components/feedback/Toast.jsx":"8797103c28a3","components/feedback/Tooltip.jsx":"7b6dc7223e54","components/forms/Checkbox.jsx":"5e2275aac13e","components/forms/Input.jsx":"406866802131","components/forms/Select.jsx":"965655a768b1","components/forms/Switch.jsx":"1618b8bf8d21","components/navigation/Tabs.jsx":"0240ab62db66","ui_kits/app/Editor.jsx":"d6ca90086d5e","ui_kits/app/EntryList.jsx":"49c95a3aaf64","ui_kits/app/Login.jsx":"ce38ffe455e4","ui_kits/app/Settings.jsx":"f875bd48fb21","ui_kits/app/Sidebar.jsx":"2b113ceb7ab4","ui_kits/app/app.jsx":"3556b999a7b0","ui_kits/app/data.jsx":"12eeec4de4a3","ui_kits/app/shared.jsx":"191c0cdf8193","ui_kits/portfolio/AboutScreen.jsx":"db055294f423","ui_kits/portfolio/Header.jsx":"1ad56aff08b8","ui_kits/portfolio/HomeScreen.jsx":"47e7cef328c4","ui_kits/portfolio/ProjectScreen.jsx":"2c8bd4167a70","ui_kits/portfolio/WorkScreen.jsx":"fbdbbb1dcfa3","ui_kits/portfolio/WritingScreen.jsx":"0b71e13e9a28","ui_kits/portfolio/app.jsx":"04c43cdab6a1","ui_kits/portfolio/data.jsx":"89e8dc18e6fb","ui_kits/portfolio/shared.jsx":"edfd9f89c0a3"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.HarborDesignSystem_372bd7 = window.HarborDesignSystem_372bd7 || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// components/core/Avatar.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
if (typeof document !== "undefined" && !document.getElementById("harbor-avatar-css")) {
  const el = document.createElement("style");
  el.id = "harbor-avatar-css";
  el.textContent = `
.hb-avatar{
  --_s:40px;
  position:relative; display:inline-flex; align-items:center; justify-content:center;
  width:var(--_s); height:var(--_s); border-radius:var(--radius-full); overflow:hidden;
  font-family:var(--font-sans); font-weight:var(--weight-semibold); font-size:calc(var(--_s) * 0.38);
  letter-spacing:var(--tracking-snug); color:var(--blue-900); flex:none;
  background:var(--blue-200); user-select:none;
}
.hb-avatar--sm{ --_s:28px; } .hb-avatar--lg{ --_s:56px; } .hb-avatar--xl{ --_s:80px; }
.hb-avatar--square{ border-radius:var(--radius-md); }
.hb-avatar img{ width:100%; height:100%; object-fit:cover; }
.hb-avatar__status{
  position:absolute; right:-1px; bottom:-1px; width:30%; height:30%; min-width:8px; min-height:8px;
  border-radius:var(--radius-full); border:2px solid var(--surface); background:var(--neutral-400);
}
.hb-avatar__status--online{ background:var(--success); }
.hb-avatar__status--busy{ background:var(--danger); }
.hb-avatar__status--away{ background:var(--warning); }
`;
  document.head.appendChild(el);
}
function initials(name = "") {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map(p => p[0] || "").join("").toUpperCase() || "?";
}

/** User avatar — image with initials fallback and optional status dot. */
function Avatar({
  src,
  name = "",
  size = "md",
  square = false,
  status,
  className = "",
  ...rest
}) {
  const cls = ["hb-avatar", size !== "md" ? `hb-avatar--${size}` : "", square ? "hb-avatar--square" : "", className].filter(Boolean).join(" ");
  return /*#__PURE__*/React.createElement("span", _extends({
    className: cls
  }, rest), src ? /*#__PURE__*/React.createElement("img", {
    src: src,
    alt: name
  }) : initials(name), status ? /*#__PURE__*/React.createElement("span", {
    className: `hb-avatar__status hb-avatar__status--${status}`
  }) : null);
}
Object.assign(__ds_scope, { Avatar });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Avatar.jsx", error: String((e && e.message) || e) }); }

// components/core/Badge.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
if (typeof document !== "undefined" && !document.getElementById("harbor-badge-css")) {
  const el = document.createElement("style");
  el.id = "harbor-badge-css";
  el.textContent = `
.hb-badge{
  display:inline-flex; align-items:center; gap:var(--space-1-5);
  height:22px; padding:0 var(--space-2); border-radius:var(--radius-full);
  font-family:var(--font-sans); font-size:var(--text-xs); font-weight:var(--weight-semibold);
  letter-spacing:var(--tracking-snug); line-height:1; white-space:nowrap;
  border:var(--border-thin) solid transparent;
}
.hb-badge--dot::before{
  content:""; width:6px; height:6px; border-radius:var(--radius-full);
  background:currentColor; opacity:.9;
}
.hb-badge--neutral{ background:var(--surface-sunken); color:var(--text); border-color:var(--border); }
.hb-badge--brand{ background:var(--accent-soft); color:var(--accent-soft-text); }
.hb-badge--success{ background:var(--success-soft); color:var(--success); }
.hb-badge--warning{ background:var(--warning-soft); color:var(--warning); }
.hb-badge--danger{ background:var(--danger-soft); color:var(--danger); }
.hb-badge--solid{ background:var(--accent); color:var(--on-accent); }
`;
  document.head.appendChild(el);
}

/** Small status / count pill. Use `dot` for a leading status dot. */
function Badge({
  variant = "neutral",
  dot = false,
  className = "",
  children,
  ...rest
}) {
  const cls = ["hb-badge", `hb-badge--${variant}`, dot ? "hb-badge--dot" : "", className].filter(Boolean).join(" ");
  return /*#__PURE__*/React.createElement("span", _extends({
    className: cls
  }, rest), children);
}
Object.assign(__ds_scope, { Badge });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Badge.jsx", error: String((e && e.message) || e) }); }

// components/core/Button.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/* Harbor · Button — injected styles (runs once) */
if (typeof document !== "undefined" && !document.getElementById("harbor-button-css")) {
  const el = document.createElement("style");
  el.id = "harbor-button-css";
  el.textContent = `
.hb-btn{
  --_h:40px; --_px:18px; --_fs:var(--text-sm);
  display:inline-flex; align-items:center; justify-content:center; gap:var(--space-2);
  height:var(--_h); padding:0 var(--_px); font-family:var(--font-sans);
  font-size:var(--_fs); font-weight:var(--weight-semibold); line-height:1;
  letter-spacing:var(--tracking-snug); border-radius:var(--radius-md);
  border:var(--border-thin) solid transparent; cursor:pointer; white-space:nowrap;
  text-decoration:none; user-select:none; transition:background var(--dur-fast) var(--ease-out),
  border-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out),
  transform var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.hb-btn:focus-visible{ box-shadow:var(--shadow-focus); }
.hb-btn:active{ transform:translateY(0.5px) scale(0.992); }
.hb-btn[disabled]{ opacity:.5; cursor:not-allowed; pointer-events:none; }
.hb-btn--sm{ --_h:32px; --_px:13px; --_fs:var(--text-xs); }
.hb-btn--lg{ --_h:48px; --_px:24px; --_fs:var(--text-base); }
.hb-btn--block{ display:flex; width:100%; }

.hb-btn--primary{ background:var(--accent); color:var(--on-accent); box-shadow:var(--shadow-xs); }
.hb-btn--primary:hover{ background:var(--accent-hover); }
.hb-btn--primary:active{ background:var(--accent-active); }

.hb-btn--secondary{ background:var(--surface); color:var(--text-strong); border-color:var(--border-strong); box-shadow:var(--shadow-xs); }
.hb-btn--secondary:hover{ background:var(--surface-hover); border-color:var(--text-muted); }

.hb-btn--ghost{ background:transparent; color:var(--text-strong); }
.hb-btn--ghost:hover{ background:var(--surface-sunken); }

.hb-btn--soft{ background:var(--accent-soft); color:var(--accent-soft-text); }
.hb-btn--soft:hover{ background:color-mix(in oklab, var(--accent) 16%, transparent); }

.hb-btn--danger{ background:var(--danger); color:#fff; }
.hb-btn--danger:hover{ background:var(--coral-600); }

.hb-btn__ico{ display:inline-flex; width:1.05em; height:1.05em; }
.hb-btn__ico svg{ width:100%; height:100%; }
`;
  document.head.appendChild(el);
}

/**
 * Harbor primary action component. Supports variants, sizes, icons,
 * and rendering as a link via the `as`/`href` props.
 */
function Button({
  variant = "primary",
  size = "md",
  fullWidth = false,
  iconLeft = null,
  iconRight = null,
  as = "button",
  className = "",
  children,
  ...rest
}) {
  const Tag = as;
  const cls = ["hb-btn", `hb-btn--${variant}`, size !== "md" ? `hb-btn--${size}` : "", fullWidth ? "hb-btn--block" : "", className].filter(Boolean).join(" ");
  return /*#__PURE__*/React.createElement(Tag, _extends({
    className: cls
  }, rest), iconLeft ? /*#__PURE__*/React.createElement("span", {
    className: "hb-btn__ico"
  }, iconLeft) : null, children, iconRight ? /*#__PURE__*/React.createElement("span", {
    className: "hb-btn__ico"
  }, iconRight) : null);
}
Object.assign(__ds_scope, { Button });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Button.jsx", error: String((e && e.message) || e) }); }

// components/core/Card.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
if (typeof document !== "undefined" && !document.getElementById("harbor-card-css")) {
  const el = document.createElement("style");
  el.id = "harbor-card-css";
  el.textContent = `
.hb-card{
  display:flex; flex-direction:column; background:var(--surface);
  border:var(--border-thin) solid var(--border); border-radius:var(--radius-lg);
  box-shadow:var(--shadow-sm); overflow:hidden;
  transition:box-shadow var(--dur) var(--ease-out), border-color var(--dur) var(--ease-out),
  transform var(--dur) var(--ease-out);
}
.hb-card--flat{ box-shadow:none; }
.hb-card--raised{ box-shadow:var(--shadow-lg); border-color:transparent; }
.hb-card--interactive{ cursor:pointer; }
.hb-card--interactive:hover{ box-shadow:var(--shadow-lg); transform:translateY(-2px); border-color:var(--border-strong); }
.hb-card__media{ display:block; width:100%; }
.hb-card__media img{ display:block; width:100%; height:100%; object-fit:cover; }
.hb-card__body{ padding:var(--space-5); display:flex; flex-direction:column; gap:var(--space-2); }
.hb-card--pad-sm .hb-card__body{ padding:var(--space-4); }
.hb-card--pad-lg .hb-card__body{ padding:var(--space-6); }
`;
  document.head.appendChild(el);
}

/** Surface container. Use `media` for a top image and put content in children. */
function Card({
  variant = "default",
  padding = "md",
  interactive = false,
  media = null,
  className = "",
  children,
  ...rest
}) {
  const cls = ["hb-card", variant !== "default" ? `hb-card--${variant}` : "", padding !== "md" ? `hb-card--pad-${padding}` : "", interactive ? "hb-card--interactive" : "", className].filter(Boolean).join(" ");
  return /*#__PURE__*/React.createElement("div", _extends({
    className: cls
  }, rest), media ? /*#__PURE__*/React.createElement("div", {
    className: "hb-card__media"
  }, media) : null, /*#__PURE__*/React.createElement("div", {
    className: "hb-card__body"
  }, children));
}
Object.assign(__ds_scope, { Card });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Card.jsx", error: String((e && e.message) || e) }); }

// components/core/IconButton.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
if (typeof document !== "undefined" && !document.getElementById("harbor-iconbtn-css")) {
  const el = document.createElement("style");
  el.id = "harbor-iconbtn-css";
  el.textContent = `
.hb-iconbtn{
  --_s:40px;
  display:inline-flex; align-items:center; justify-content:center;
  width:var(--_s); height:var(--_s); padding:0; border-radius:var(--radius-md);
  border:var(--border-thin) solid transparent; background:transparent; cursor:pointer;
  color:var(--text); transition:background var(--dur-fast) var(--ease-out),
  color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out),
  transform var(--dur-fast) var(--ease-out);
}
.hb-iconbtn:hover{ background:var(--surface-sunken); color:var(--text-strong); }
.hb-iconbtn:active{ transform:scale(0.93); }
.hb-iconbtn:focus-visible{ box-shadow:var(--shadow-focus); }
.hb-iconbtn[disabled]{ opacity:.45; cursor:not-allowed; pointer-events:none; }
.hb-iconbtn--sm{ --_s:32px; }
.hb-iconbtn--lg{ --_s:48px; }
.hb-iconbtn--solid{ background:var(--accent); color:var(--on-accent); }
.hb-iconbtn--solid:hover{ background:var(--accent-hover); color:var(--on-accent); }
.hb-iconbtn--outline{ border-color:var(--border-strong); }
.hb-iconbtn--outline:hover{ border-color:var(--text-muted); background:var(--surface-hover); }
.hb-iconbtn__ico{ display:inline-flex; width:1.15rem; height:1.15rem; }
.hb-iconbtn--lg .hb-iconbtn__ico{ width:1.4rem; height:1.4rem; }
.hb-iconbtn__ico svg{ width:100%; height:100%; }
`;
  document.head.appendChild(el);
}

/** Square, icon-only button. Always pass an accessible `aria-label`. */
function IconButton({
  variant = "ghost",
  size = "md",
  className = "",
  children,
  ...rest
}) {
  const cls = ["hb-iconbtn", variant !== "ghost" ? `hb-iconbtn--${variant}` : "", size !== "md" ? `hb-iconbtn--${size}` : "", className].filter(Boolean).join(" ");
  return /*#__PURE__*/React.createElement("button", _extends({
    className: cls
  }, rest), /*#__PURE__*/React.createElement("span", {
    className: "hb-iconbtn__ico"
  }, children));
}
Object.assign(__ds_scope, { IconButton });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/IconButton.jsx", error: String((e && e.message) || e) }); }

// components/core/Tag.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
if (typeof document !== "undefined" && !document.getElementById("harbor-tag-css")) {
  const el = document.createElement("style");
  el.id = "harbor-tag-css";
  el.textContent = `
.hb-tag{
  display:inline-flex; align-items:center; gap:var(--space-1-5);
  height:28px; padding:0 var(--space-3); border-radius:var(--radius-sm);
  font-family:var(--font-sans); font-size:var(--text-sm); font-weight:var(--weight-medium);
  color:var(--text); background:var(--surface); border:var(--border-thin) solid var(--border);
  line-height:1; white-space:nowrap; transition:background var(--dur-fast) var(--ease-out),
  border-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.hb-tag--interactive{ cursor:pointer; }
.hb-tag--interactive:hover{ border-color:var(--border-strong); background:var(--surface-hover); }
.hb-tag--selected{ background:var(--accent-soft); border-color:var(--border-brand); color:var(--accent-soft-text); }
.hb-tag__x{
  display:inline-flex; align-items:center; justify-content:center; margin-right:-4px;
  width:16px; height:16px; border-radius:var(--radius-full); border:0; background:transparent;
  cursor:pointer; color:inherit; opacity:.6; transition:opacity var(--dur-fast) var(--ease-out);
}
.hb-tag__x:hover{ opacity:1; }
.hb-tag__x svg{ width:12px; height:12px; }
`;
  document.head.appendChild(el);
}
const Cross = /*#__PURE__*/React.createElement("svg", {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: "2.5",
  strokeLinecap: "round"
}, /*#__PURE__*/React.createElement("path", {
  d: "M18 6 6 18M6 6l12 12"
}));

/** Removable / selectable keyword chip (filters, categories, multi-select). */
function Tag({
  selected = false,
  interactive = false,
  onRemove,
  className = "",
  children,
  ...rest
}) {
  const cls = ["hb-tag", interactive || onRemove ? "hb-tag--interactive" : "", selected ? "hb-tag--selected" : "", className].filter(Boolean).join(" ");
  return /*#__PURE__*/React.createElement("span", _extends({
    className: cls
  }, rest), children, onRemove ? /*#__PURE__*/React.createElement("button", {
    className: "hb-tag__x",
    "aria-label": "Remove",
    onClick: onRemove
  }, Cross) : null);
}
Object.assign(__ds_scope, { Tag });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Tag.jsx", error: String((e && e.message) || e) }); }

// components/feedback/Toast.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
if (typeof document !== "undefined" && !document.getElementById("harbor-toast-css")) {
  const el = document.createElement("style");
  el.id = "harbor-toast-css";
  el.textContent = `
.hb-toast{
  display:flex; align-items:flex-start; gap:var(--space-3); width:min(380px, 92vw);
  padding:var(--space-3) var(--space-4); background:var(--surface);
  border:var(--border-thin) solid var(--border); border-left:3px solid var(--accent);
  border-radius:var(--radius-md); box-shadow:var(--shadow-lg);
  font-family:var(--font-sans);
}
.hb-toast--success{ border-left-color:var(--success); }
.hb-toast--warning{ border-left-color:var(--warning); }
.hb-toast--danger{ border-left-color:var(--danger); }
.hb-toast__ico{ flex:none; width:1.15rem; height:1.15rem; margin-top:1px; color:var(--accent); }
.hb-toast--success .hb-toast__ico{ color:var(--success); }
.hb-toast--warning .hb-toast__ico{ color:var(--warning); }
.hb-toast--danger .hb-toast__ico{ color:var(--danger); }
.hb-toast__ico svg{ width:100%; height:100%; }
.hb-toast__body{ flex:1; min-width:0; display:flex; flex-direction:column; gap:2px; }
.hb-toast__title{ font-size:var(--text-sm); font-weight:var(--weight-semibold); color:var(--text-strong); }
.hb-toast__msg{ font-size:var(--text-sm); color:var(--text-muted); line-height:var(--leading-snug); }
.hb-toast__close{ flex:none; border:0; background:transparent; cursor:pointer; color:var(--text-muted); padding:2px; border-radius:var(--radius-xs); }
.hb-toast__close:hover{ color:var(--text-strong); }
.hb-toast__close svg{ width:15px; height:15px; }
`;
  document.head.appendChild(el);
}
const icons = {
  info: /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, /*#__PURE__*/React.createElement("circle", {
    cx: "12",
    cy: "12",
    r: "10"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M12 16v-4M12 8h.01"
  })),
  success: /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M21.8 10A10 10 0 1 1 17 3.3"
  }), /*#__PURE__*/React.createElement("path", {
    d: "m9 11 3 3L22 4"
  })),
  warning: /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, /*#__PURE__*/React.createElement("path", {
    d: "m21.7 18-9-16a1 1 0 0 0-1.7 0l-9 16a1 1 0 0 0 .9 1.5h18a1 1 0 0 0 .9-1.5Z"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M12 9v4M12 17h.01"
  })),
  danger: /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, /*#__PURE__*/React.createElement("circle", {
    cx: "12",
    cy: "12",
    r: "10"
  }), /*#__PURE__*/React.createElement("path", {
    d: "m15 9-6 6M9 9l6 6"
  }))
};
const Close = /*#__PURE__*/React.createElement("svg", {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: "2.2",
  strokeLinecap: "round"
}, /*#__PURE__*/React.createElement("path", {
  d: "M18 6 6 18M6 6l12 12"
}));

/** Transient notification card. Render inside a fixed-position stack. */
function Toast({
  variant = "info",
  title,
  children,
  onClose,
  className = "",
  ...rest
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    className: ["hb-toast", `hb-toast--${variant}`, className].filter(Boolean).join(" "),
    role: "status"
  }, rest), /*#__PURE__*/React.createElement("span", {
    className: "hb-toast__ico"
  }, icons[variant]), /*#__PURE__*/React.createElement("div", {
    className: "hb-toast__body"
  }, title ? /*#__PURE__*/React.createElement("span", {
    className: "hb-toast__title"
  }, title) : null, children ? /*#__PURE__*/React.createElement("span", {
    className: "hb-toast__msg"
  }, children) : null), onClose ? /*#__PURE__*/React.createElement("button", {
    className: "hb-toast__close",
    "aria-label": "Dismiss",
    onClick: onClose
  }, Close) : null);
}
Object.assign(__ds_scope, { Toast });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/Toast.jsx", error: String((e && e.message) || e) }); }

// components/feedback/Tooltip.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
if (typeof document !== "undefined" && !document.getElementById("harbor-tooltip-css")) {
  const el = document.createElement("style");
  el.id = "harbor-tooltip-css";
  el.textContent = `
.hb-tip{ position:relative; display:inline-flex; }
.hb-tip__bubble{
  position:absolute; z-index:50; left:50%; transform:translateX(-50%) translateY(4px);
  padding:var(--space-2) var(--space-3); border-radius:var(--radius-sm);
  background:var(--neutral-900); color:var(--neutral-50);
  font-family:var(--font-sans); font-size:var(--text-xs); font-weight:var(--weight-medium);
  line-height:var(--leading-snug); white-space:nowrap; box-shadow:var(--shadow-lg);
  opacity:0; pointer-events:none; transition:opacity var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out);
}
.hb-tip__bubble--top{ bottom:calc(100% + 8px); }
.hb-tip__bubble--bottom{ top:calc(100% + 8px); }
.hb-tip:hover .hb-tip__bubble, .hb-tip:focus-within .hb-tip__bubble{ opacity:1; transform:translateX(-50%) translateY(0); }
.hb-tip__bubble::after{
  content:""; position:absolute; left:50%; margin-left:-4px; border:4px solid transparent;
}
.hb-tip__bubble--top::after{ top:100%; border-top-color:var(--neutral-900); }
.hb-tip__bubble--bottom::after{ bottom:100%; border-bottom-color:var(--neutral-900); }
`;
  document.head.appendChild(el);
}

/** Hover/focus tooltip wrapping a single trigger element. */
function Tooltip({
  label,
  side = "top",
  className = "",
  children,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("span", _extends({
    className: ["hb-tip", className].filter(Boolean).join(" ")
  }, rest), children, /*#__PURE__*/React.createElement("span", {
    className: `hb-tip__bubble hb-tip__bubble--${side}`,
    role: "tooltip"
  }, label));
}
Object.assign(__ds_scope, { Tooltip });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/Tooltip.jsx", error: String((e && e.message) || e) }); }

// components/forms/Checkbox.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
if (typeof document !== "undefined" && !document.getElementById("harbor-checkbox-css")) {
  const el = document.createElement("style");
  el.id = "harbor-checkbox-css";
  el.textContent = `
.hb-check{ display:inline-flex; align-items:flex-start; gap:var(--space-2); cursor:pointer; font-family:var(--font-sans); }
.hb-check--disabled{ opacity:.5; cursor:not-allowed; }
.hb-check__input{ position:absolute; opacity:0; width:0; height:0; }
.hb-check__box{
  flex:none; width:18px; height:18px; margin-top:1px; border-radius:var(--radius-xs);
  border:var(--border-thick) solid var(--border-strong); background:var(--surface);
  display:inline-flex; align-items:center; justify-content:center; color:var(--on-accent);
  transition:background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out);
}
.hb-check__box svg{ width:13px; height:13px; opacity:0; transform:scale(.6); transition:opacity var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-spring); }
.hb-check__input:checked + .hb-check__box{ background:var(--accent); border-color:var(--accent); }
.hb-check__input:checked + .hb-check__box svg{ opacity:1; transform:scale(1); }
.hb-check__input:focus-visible + .hb-check__box{ box-shadow:var(--shadow-focus); }
.hb-check__text{ display:flex; flex-direction:column; gap:1px; }
.hb-check__label{ font-size:var(--text-sm); color:var(--text-strong); line-height:var(--leading-snug); }
.hb-check__desc{ font-size:var(--text-xs); color:var(--text-muted); }
`;
  document.head.appendChild(el);
}
const Check = /*#__PURE__*/React.createElement("svg", {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: "3.5",
  strokeLinecap: "round",
  strokeLinejoin: "round"
}, /*#__PURE__*/React.createElement("path", {
  d: "M20 6 9 17l-5-5"
}));

/** Checkbox with label and optional description. */
function Checkbox({
  label,
  description,
  disabled = false,
  id,
  className = "",
  ...rest
}) {
  const cid = id || (label ? `hb-cb-${label.replace(/\s+/g, "-").toLowerCase()}` : undefined);
  return /*#__PURE__*/React.createElement("label", {
    className: ["hb-check", disabled ? "hb-check--disabled" : "", className].filter(Boolean).join(" "),
    htmlFor: cid
  }, /*#__PURE__*/React.createElement("input", _extends({
    className: "hb-check__input",
    type: "checkbox",
    id: cid,
    disabled: disabled
  }, rest)), /*#__PURE__*/React.createElement("span", {
    className: "hb-check__box"
  }, Check), label || description ? /*#__PURE__*/React.createElement("span", {
    className: "hb-check__text"
  }, label ? /*#__PURE__*/React.createElement("span", {
    className: "hb-check__label"
  }, label) : null, description ? /*#__PURE__*/React.createElement("span", {
    className: "hb-check__desc"
  }, description) : null) : null);
}
Object.assign(__ds_scope, { Checkbox });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Checkbox.jsx", error: String((e && e.message) || e) }); }

// components/forms/Input.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
if (typeof document !== "undefined" && !document.getElementById("harbor-input-css")) {
  const el = document.createElement("style");
  el.id = "harbor-input-css";
  el.textContent = `
.hb-field{ display:flex; flex-direction:column; gap:var(--space-1-5); }
.hb-field__label{ font-family:var(--font-sans); font-size:var(--text-sm); font-weight:var(--weight-medium); color:var(--text-strong); }
.hb-field__label span{ color:var(--danger); margin-left:2px; }
.hb-input-wrap{
  display:flex; align-items:center; gap:var(--space-2);
  background:var(--surface); border:var(--border-thin) solid var(--border);
  border-radius:var(--radius-md); padding:0 var(--space-3); height:42px;
  transition:border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.hb-input-wrap:hover{ border-color:var(--border-strong); }
.hb-input-wrap:focus-within{ border-color:var(--border-brand); box-shadow:var(--shadow-focus); }
.hb-input-wrap--invalid{ border-color:var(--danger); }
.hb-input-wrap--invalid:focus-within{ box-shadow:0 0 0 3px var(--danger-soft); }
.hb-input-wrap--disabled{ opacity:.55; pointer-events:none; background:var(--surface-sunken); }
.hb-input{
  flex:1; min-width:0; border:0; background:transparent; outline:none;
  font-family:var(--font-sans); font-size:var(--text-sm); color:var(--text-strong); height:100%;
}
.hb-input::placeholder{ color:var(--text-muted); }
.hb-input-wrap__affix{ display:inline-flex; align-items:center; color:var(--text-muted); flex:none; }
.hb-input-wrap__affix svg{ width:1.05rem; height:1.05rem; }
.hb-field__hint{ font-size:var(--text-xs); color:var(--text-muted); }
.hb-field__hint--err{ color:var(--danger); }
`;
  document.head.appendChild(el);
}

/** Labelled text input with optional affixes, hint, and error state. */
function Input({
  label,
  required = false,
  hint,
  error,
  prefix = null,
  suffix = null,
  disabled = false,
  id,
  className = "",
  ...rest
}) {
  const inputId = id || (label ? `hb-${label.replace(/\s+/g, "-").toLowerCase()}` : undefined);
  const wrap = ["hb-input-wrap", error ? "hb-input-wrap--invalid" : "", disabled ? "hb-input-wrap--disabled" : ""].filter(Boolean).join(" ");
  return /*#__PURE__*/React.createElement("div", {
    className: ["hb-field", className].filter(Boolean).join(" ")
  }, label ? /*#__PURE__*/React.createElement("label", {
    className: "hb-field__label",
    htmlFor: inputId
  }, label, required ? /*#__PURE__*/React.createElement("span", null, "*") : null) : null, /*#__PURE__*/React.createElement("div", {
    className: wrap
  }, prefix ? /*#__PURE__*/React.createElement("span", {
    className: "hb-input-wrap__affix"
  }, prefix) : null, /*#__PURE__*/React.createElement("input", _extends({
    className: "hb-input",
    id: inputId,
    disabled: disabled,
    "aria-invalid": !!error
  }, rest)), suffix ? /*#__PURE__*/React.createElement("span", {
    className: "hb-input-wrap__affix"
  }, suffix) : null), error ? /*#__PURE__*/React.createElement("span", {
    className: "hb-field__hint hb-field__hint--err"
  }, error) : hint ? /*#__PURE__*/React.createElement("span", {
    className: "hb-field__hint"
  }, hint) : null);
}
Object.assign(__ds_scope, { Input });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Input.jsx", error: String((e && e.message) || e) }); }

// components/forms/Select.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
if (typeof document !== "undefined" && !document.getElementById("harbor-select-css")) {
  const el = document.createElement("style");
  el.id = "harbor-select-css";
  el.textContent = `
.hb-select-wrap{ position:relative; display:flex; flex-direction:column; gap:var(--space-1-5); }
.hb-select-wrap__label{ font-family:var(--font-sans); font-size:var(--text-sm); font-weight:var(--weight-medium); color:var(--text-strong); }
.hb-select-field{ position:relative; display:flex; align-items:center; }
.hb-select{
  appearance:none; width:100%; height:42px; padding:0 38px 0 var(--space-3);
  font-family:var(--font-sans); font-size:var(--text-sm); color:var(--text-strong);
  background:var(--surface); border:var(--border-thin) solid var(--border);
  border-radius:var(--radius-md); cursor:pointer; outline:none;
  transition:border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.hb-select:hover{ border-color:var(--border-strong); }
.hb-select:focus-visible{ border-color:var(--border-brand); box-shadow:var(--shadow-focus); }
.hb-select:disabled{ opacity:.55; cursor:not-allowed; background:var(--surface-sunken); }
.hb-select__chev{
  position:absolute; right:var(--space-3); pointer-events:none; color:var(--text-muted);
  width:1.05rem; height:1.05rem;
}
.hb-select__chev svg{ width:100%; height:100%; }
`;
  document.head.appendChild(el);
}
const Chevron = /*#__PURE__*/React.createElement("svg", {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: "2",
  strokeLinecap: "round",
  strokeLinejoin: "round"
}, /*#__PURE__*/React.createElement("path", {
  d: "m6 9 6 6 6-6"
}));

/** Native-select dropdown styled to match Harbor inputs. */
function Select({
  label,
  options = [],
  placeholder,
  id,
  className = "",
  children,
  ...rest
}) {
  const selectId = id || (label ? `hb-sel-${label.replace(/\s+/g, "-").toLowerCase()}` : undefined);
  return /*#__PURE__*/React.createElement("div", {
    className: ["hb-select-wrap", className].filter(Boolean).join(" ")
  }, label ? /*#__PURE__*/React.createElement("label", {
    className: "hb-select-wrap__label",
    htmlFor: selectId
  }, label) : null, /*#__PURE__*/React.createElement("div", {
    className: "hb-select-field"
  }, /*#__PURE__*/React.createElement("select", _extends({
    className: "hb-select",
    id: selectId
  }, rest), placeholder ? /*#__PURE__*/React.createElement("option", {
    value: "",
    disabled: true
  }, placeholder) : null, children ?? options.map(o => {
    const opt = typeof o === "string" ? {
      value: o,
      label: o
    } : o;
    return /*#__PURE__*/React.createElement("option", {
      key: opt.value,
      value: opt.value
    }, opt.label);
  })), /*#__PURE__*/React.createElement("span", {
    className: "hb-select__chev"
  }, Chevron)));
}
Object.assign(__ds_scope, { Select });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Select.jsx", error: String((e && e.message) || e) }); }

// components/forms/Switch.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
if (typeof document !== "undefined" && !document.getElementById("harbor-switch-css")) {
  const el = document.createElement("style");
  el.id = "harbor-switch-css";
  el.textContent = `
.hb-switch{ display:inline-flex; align-items:center; gap:var(--space-2); cursor:pointer; font-family:var(--font-sans); }
.hb-switch--disabled{ opacity:.5; cursor:not-allowed; }
.hb-switch__input{ position:absolute; opacity:0; width:0; height:0; }
.hb-switch__track{
  position:relative; flex:none; width:38px; height:22px; border-radius:var(--radius-full);
  background:var(--neutral-300); transition:background var(--dur) var(--ease-out);
}
.hb-switch__thumb{
  position:absolute; top:2px; left:2px; width:18px; height:18px; border-radius:var(--radius-full);
  background:#fff; box-shadow:var(--shadow-sm); transition:transform var(--dur) var(--ease-spring);
}
.hb-switch__input:checked + .hb-switch__track{ background:var(--accent); }
.hb-switch__input:checked + .hb-switch__track .hb-switch__thumb{ transform:translateX(16px); }
.hb-switch__input:focus-visible + .hb-switch__track{ box-shadow:var(--shadow-focus); }
.hb-switch__label{ font-size:var(--text-sm); color:var(--text-strong); }
`;
  document.head.appendChild(el);
}

/** Toggle for binary settings that apply immediately. */
function Switch({
  label,
  disabled = false,
  id,
  className = "",
  ...rest
}) {
  const sid = id || (label ? `hb-sw-${label.replace(/\s+/g, "-").toLowerCase()}` : undefined);
  return /*#__PURE__*/React.createElement("label", {
    className: ["hb-switch", disabled ? "hb-switch--disabled" : "", className].filter(Boolean).join(" "),
    htmlFor: sid
  }, /*#__PURE__*/React.createElement("input", _extends({
    className: "hb-switch__input",
    type: "checkbox",
    role: "switch",
    id: sid,
    disabled: disabled
  }, rest)), /*#__PURE__*/React.createElement("span", {
    className: "hb-switch__track"
  }, /*#__PURE__*/React.createElement("span", {
    className: "hb-switch__thumb"
  })), label ? /*#__PURE__*/React.createElement("span", {
    className: "hb-switch__label"
  }, label) : null);
}
Object.assign(__ds_scope, { Switch });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Switch.jsx", error: String((e && e.message) || e) }); }

// components/navigation/Tabs.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
if (typeof document !== "undefined" && !document.getElementById("harbor-tabs-css")) {
  const el = document.createElement("style");
  el.id = "harbor-tabs-css";
  el.textContent = `
.hb-tabs{ display:flex; gap:var(--space-1); align-items:center; border-bottom:var(--border-thin) solid var(--border); }
.hb-tabs--pill{ border:0; gap:var(--space-1); padding:var(--space-1); background:var(--surface-sunken); border-radius:var(--radius-md); display:inline-flex; }
.hb-tab{
  position:relative; appearance:none; border:0; background:transparent; cursor:pointer;
  font-family:var(--font-sans); font-size:var(--text-sm); font-weight:var(--weight-medium);
  color:var(--text-muted); padding:var(--space-3) var(--space-3); display:inline-flex; align-items:center;
  gap:var(--space-2); transition:color var(--dur-fast) var(--ease-out);
}
.hb-tab:hover{ color:var(--text-strong); }
.hb-tab__count{ font-family:var(--font-mono); font-size:var(--text-xs); color:var(--text-muted); }
.hb-tab--active{ color:var(--text-strong); }
.hb-tab--active::after{
  content:""; position:absolute; left:var(--space-3); right:var(--space-3); bottom:-1px; height:2px;
  background:var(--accent); border-radius:var(--radius-full);
}
.hb-tabs--pill .hb-tab{ padding:var(--space-2) var(--space-4); border-radius:var(--radius-sm); }
.hb-tabs--pill .hb-tab--active{ background:var(--surface); color:var(--text-strong); box-shadow:var(--shadow-xs); }
.hb-tabs--pill .hb-tab--active::after{ display:none; }
`;
  document.head.appendChild(el);
}

/** Controlled tab bar. Pass `items`, the active `value`, and `onChange`. */
function Tabs({
  items = [],
  value,
  onChange,
  variant = "underline",
  className = "",
  ...rest
}) {
  const cls = ["hb-tabs", variant === "pill" ? "hb-tabs--pill" : "", className].filter(Boolean).join(" ");
  return /*#__PURE__*/React.createElement("div", _extends({
    className: cls,
    role: "tablist"
  }, rest), items.map(it => {
    const item = typeof it === "string" ? {
      value: it,
      label: it
    } : it;
    const active = item.value === value;
    return /*#__PURE__*/React.createElement("button", {
      key: item.value,
      role: "tab",
      "aria-selected": active,
      className: ["hb-tab", active ? "hb-tab--active" : ""].filter(Boolean).join(" "),
      onClick: () => onChange && onChange(item.value)
    }, item.icon ? /*#__PURE__*/React.createElement("span", {
      className: "hb-btn__ico",
      style: {
        width: "1.05em",
        height: "1.05em"
      }
    }, item.icon) : null, item.label, item.count != null ? /*#__PURE__*/React.createElement("span", {
      className: "hb-tab__count"
    }, item.count) : null);
  }));
}
Object.assign(__ds_scope, { Tabs });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/navigation/Tabs.jsx", error: String((e && e.message) || e) }); }

// ui_kits/app/Editor.jsx
try { (() => {
/* Harbor app (Tidal) — main editor pane */
const {
  Button,
  Badge,
  Tag,
  IconButton,
  Tooltip
} = window.HarborDesignSystem_372bd7;
function Editor({
  entry,
  onSave
}) {
  const [title, setTitle] = React.useState(entry.title);
  const [body, setBody] = React.useState(entry.body);
  React.useEffect(() => {
    setTitle(entry.title);
    setBody(entry.body);
  }, [entry.id]);
  const words = body.trim() ? body.trim().split(/\s+/).length : 0;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0,
      display: "flex",
      flexDirection: "column",
      background: "var(--surface)"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 12,
      padding: "14px 28px",
      borderBottom: "1px solid var(--border)"
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "harbor-eyebrow"
  }, entry.date), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 6,
      marginLeft: 4
    }
  }, entry.tags.map(t => /*#__PURE__*/React.createElement(Badge, {
    key: t,
    variant: "neutral",
    dot: true
  }, t))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginLeft: "auto",
      display: "flex",
      alignItems: "center",
      gap: 6
    }
  }, /*#__PURE__*/React.createElement(Tooltip, {
    label: "Bold"
  }, /*#__PURE__*/React.createElement(IconButton, {
    size: "sm",
    "aria-label": "Bold"
  }, AIco("bold"))), /*#__PURE__*/React.createElement(Tooltip, {
    label: "Italic"
  }, /*#__PURE__*/React.createElement(IconButton, {
    size: "sm",
    "aria-label": "Italic"
  }, AIco("italic"))), /*#__PURE__*/React.createElement(Tooltip, {
    label: "Link"
  }, /*#__PURE__*/React.createElement(IconButton, {
    size: "sm",
    "aria-label": "Link"
  }, AIco("link"))), /*#__PURE__*/React.createElement("span", {
    style: {
      width: 1,
      height: 20,
      background: "var(--border)",
      margin: "0 4px"
    }
  }), /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    size: "sm",
    iconLeft: AIco("check"),
    onClick: () => onSave(title)
  }, "Save"))), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      overflowY: "auto"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 680,
      margin: "0 auto",
      padding: "48px 28px 120px"
    }
  }, /*#__PURE__*/React.createElement("input", {
    value: title,
    onChange: e => setTitle(e.target.value),
    placeholder: "Untitled",
    style: {
      width: "100%",
      border: 0,
      outline: "none",
      background: "transparent",
      fontFamily: "var(--font-display)",
      fontWeight: 600,
      fontSize: "2.5rem",
      letterSpacing: "-0.025em",
      color: "var(--text-strong)",
      marginBottom: 18
    }
  }), /*#__PURE__*/React.createElement("textarea", {
    value: body,
    onChange: e => setBody(e.target.value),
    placeholder: "Start writing. The tide will take care of the rest.",
    style: {
      width: "100%",
      minHeight: 360,
      border: 0,
      outline: "none",
      resize: "none",
      background: "transparent",
      fontFamily: "var(--font-sans)",
      fontSize: "1.125rem",
      lineHeight: 1.75,
      color: "var(--text)"
    }
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 18,
      padding: "10px 28px",
      borderTop: "1px solid var(--border)",
      background: "var(--bg)",
      fontFamily: "var(--font-mono)",
      fontSize: 11.5,
      color: "var(--text-muted)"
    }
  }, /*#__PURE__*/React.createElement("span", null, words, " words"), /*#__PURE__*/React.createElement("span", null, "\xB7"), /*#__PURE__*/React.createElement("span", null, Math.max(1, Math.round(words / 200)), " min read"), /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: "auto",
      display: "inline-flex",
      alignItems: "center",
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("i", {
    "data-lucide": "cloud",
    style: {
      width: 14,
      height: 14
    }
  }), " Synced")));
}
Object.assign(window, {
  Editor
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/app/Editor.jsx", error: String((e && e.message) || e) }); }

// ui_kits/app/EntryList.jsx
try { (() => {
/* Harbor app (Tidal) — entry list column */
const {
  Input,
  Button,
  Badge,
  IconButton
} = window.HarborDesignSystem_372bd7;
function EntryList({
  folder,
  selectedId,
  onSelect,
  onNew
}) {
  const [q, setQ] = React.useState("");
  const list = ENTRIES.filter(e => folder === "all" ? true : e.folder === folder).filter(e => e.title.toLowerCase().includes(q.toLowerCase()));
  const label = (FOLDERS.find(f => f.key === folder) || {}).label || "Entries";
  return /*#__PURE__*/React.createElement("div", {
    style: {
      width: 320,
      flex: "none",
      borderRight: "1px solid var(--border)",
      background: "var(--bg)",
      display: "flex",
      flexDirection: "column"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "18px 18px 12px",
      display: "flex",
      flexDirection: "column",
      gap: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between"
    }
  }, /*#__PURE__*/React.createElement("h2", {
    style: {
      fontSize: "1.25rem"
    }
  }, label), /*#__PURE__*/React.createElement(Button, {
    variant: "soft",
    size: "sm",
    iconLeft: AIco("plus"),
    onClick: onNew
  }, "New")), /*#__PURE__*/React.createElement(Input, {
    prefix: AIco("search"),
    placeholder: "Search entries",
    value: q,
    onChange: e => setQ(e.target.value)
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      overflowY: "auto",
      padding: "4px 12px 16px"
    }
  }, list.length === 0 ? /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "40px 16px",
      textAlign: "center",
      color: "var(--text-muted)"
    }
  }, /*#__PURE__*/React.createElement("i", {
    "data-lucide": "feather",
    style: {
      width: 26,
      height: 26,
      opacity: 0.6
    }
  }), /*#__PURE__*/React.createElement("p", {
    style: {
      marginTop: 10,
      fontSize: "0.9rem"
    }
  }, "Nothing here yet.", /*#__PURE__*/React.createElement("br", null), "The first note is the hardest.")) : list.map(e => {
    const active = e.id === selectedId;
    return /*#__PURE__*/React.createElement("button", {
      key: e.id,
      onClick: () => onSelect(e.id),
      style: {
        width: "100%",
        textAlign: "left",
        border: 0,
        cursor: "pointer",
        background: active ? "var(--surface)" : "transparent",
        boxShadow: active ? "var(--shadow-sm)" : "none",
        borderRadius: "var(--radius-md)",
        padding: "12px 13px",
        marginBottom: 4,
        opacity: 1 - e.fade * 0.55,
        transition: "background var(--dur-fast) var(--ease-out), opacity var(--dur) var(--ease-out)"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        justifyContent: "space-between",
        gap: 8,
        alignItems: "baseline"
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: "var(--font-display)",
        fontWeight: 600,
        fontSize: "1.0625rem",
        color: "var(--text-strong)"
      }
    }, e.title)), /*#__PURE__*/React.createElement("div", {
      style: {
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        color: "var(--text-muted)",
        margin: "3px 0 6px"
      }
    }, e.date), /*#__PURE__*/React.createElement("p", {
      style: {
        fontSize: "0.86rem",
        color: "var(--text-muted)",
        lineHeight: 1.45,
        display: "-webkit-box",
        WebkitLineClamp: 2,
        WebkitBoxOrient: "vertical",
        overflow: "hidden"
      }
    }, e.body.split("\n")[0]));
  })));
}
Object.assign(window, {
  EntryList
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/app/EntryList.jsx", error: String((e && e.message) || e) }); }

// ui_kits/app/Login.jsx
try { (() => {
/* Harbor app (Tidal) — login / welcome screen */
const {
  Button,
  Input,
  Checkbox
} = window.HarborDesignSystem_372bd7;
function Login({
  onEnter
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      minHeight: "100vh",
      display: "grid",
      gridTemplateColumns: "1.1fr 1fr",
      background: "var(--bg)"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: 40
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: "100%",
      maxWidth: 360
    }
  }, /*#__PURE__*/React.createElement(AppLogo, {
    size: 30
  }), /*#__PURE__*/React.createElement("h1", {
    style: {
      fontSize: "2rem",
      marginTop: 34,
      letterSpacing: "-0.02em"
    }
  }, "Welcome back"), /*#__PURE__*/React.createElement("p", {
    style: {
      color: "var(--text-muted)",
      marginTop: 10,
      marginBottom: 30
    }
  }, "A safe place to set things down. You're not alone in this."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 16
    }
  }, /*#__PURE__*/React.createElement(Input, {
    label: "Email",
    type: "email",
    prefix: AIco("mail"),
    defaultValue: "maya@harbor.studio"
  }), /*#__PURE__*/React.createElement(Input, {
    label: "Password",
    type: "password",
    prefix: AIco("lock"),
    defaultValue: "tidalwaves"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between"
    }
  }, /*#__PURE__*/React.createElement(Checkbox, {
    label: "Stay signed in",
    defaultChecked: true
  }), /*#__PURE__*/React.createElement("a", {
    href: "#",
    onClick: e => e.preventDefault(),
    style: {
      fontSize: "0.9rem",
      fontWeight: 500
    }
  }, "Forgot?")), /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    fullWidth: true,
    onClick: onEnter,
    iconRight: AIco("arrow-right")
  }, "Enter Tidal")), /*#__PURE__*/React.createElement("p", {
    style: {
      marginTop: 22,
      fontSize: "0.9rem",
      color: "var(--text-muted)",
      textAlign: "center"
    }
  }, "New here? ", /*#__PURE__*/React.createElement("a", {
    href: "#",
    onClick: e => {
      e.preventDefault();
      onEnter();
    },
    style: {
      fontWeight: 500
    }
  }, "Make an account")))), /*#__PURE__*/React.createElement("div", {
    style: {
      position: "relative",
      overflow: "hidden",
      background: "linear-gradient(160deg, var(--blue-800), var(--blue-950))",
      display: "flex",
      alignItems: "flex-end",
      padding: 48
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      top: 40,
      right: 44,
      color: "color-mix(in oklab, var(--blue-300) 60%, transparent)"
    }
  }, /*#__PURE__*/React.createElement("i", {
    "data-lucide": "waves",
    style: {
      width: 120,
      height: 120
    }
  })), /*#__PURE__*/React.createElement("blockquote", {
    style: {
      margin: 0,
      color: "var(--neutral-50)",
      maxWidth: 360
    }
  }, /*#__PURE__*/React.createElement("p", {
    style: {
      fontFamily: "var(--font-display)",
      fontSize: "1.625rem",
      fontStyle: "italic",
      lineHeight: 1.4
    }
  }, "\"The water pulled back overnight and left the whole bay glassy.\""), /*#__PURE__*/React.createElement("footer", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: 12,
      marginTop: 16,
      color: "var(--brand-teal-300)",
      letterSpacing: ".14em"
    }
  }, "CALM FROM THE STORM"))));
}
Object.assign(window, {
  Login
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/app/Login.jsx", error: String((e && e.message) || e) }); }

// ui_kits/app/Settings.jsx
try { (() => {
/* Harbor app (Tidal) — settings view */
const {
  Card,
  Switch,
  Select,
  Input,
  Button,
  Tag,
  Badge
} = window.HarborDesignSystem_372bd7;
function Row({
  title,
  desc,
  children
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 20,
      padding: "18px 0",
      borderBottom: "1px solid var(--border)"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 600,
      color: "var(--text-strong)",
      fontSize: "0.975rem"
    }
  }, title), desc ? /*#__PURE__*/React.createElement("div", {
    style: {
      color: "var(--text-muted)",
      fontSize: "0.875rem",
      marginTop: 2
    }
  }, desc) : null), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: "none"
    }
  }, children));
}
function Settings({
  dark,
  setDark
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      overflowY: "auto",
      background: "var(--bg)"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 640,
      margin: "0 auto",
      padding: "48px 28px 100px"
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "harbor-eyebrow"
  }, "Settings"), /*#__PURE__*/React.createElement("h1", {
    style: {
      fontSize: "2.25rem",
      marginTop: 10,
      marginBottom: 6,
      letterSpacing: "-0.02em"
    }
  }, "Preferences"), /*#__PURE__*/React.createElement("p", {
    style: {
      color: "var(--text-muted)",
      marginBottom: 30
    }
  }, "Tune how Tidal looks and how the tide behaves."), /*#__PURE__*/React.createElement("h2", {
    style: {
      fontSize: "1.25rem",
      marginBottom: 4
    }
  }, "Appearance"), /*#__PURE__*/React.createElement(Row, {
    title: "Dark mode",
    desc: "Easier on the eyes after sundown."
  }, /*#__PURE__*/React.createElement(Switch, {
    checked: dark,
    onChange: e => setDark(e.target.checked)
  })), /*#__PURE__*/React.createElement(Row, {
    title: "Editor font",
    desc: "What you write in."
  }, /*#__PURE__*/React.createElement(Select, {
    options: ["Hanken Grotesk", "Newsreader", "JetBrains Mono"],
    defaultValue: "Hanken Grotesk"
  })), /*#__PURE__*/React.createElement(Row, {
    title: "Reduce motion",
    desc: "Calm the fade animation."
  }, /*#__PURE__*/React.createElement(Switch, null)), /*#__PURE__*/React.createElement("h2", {
    style: {
      fontSize: "1.25rem",
      margin: "34px 0 4px"
    }
  }, "The tide"), /*#__PURE__*/React.createElement(Row, {
    title: "Fade older entries",
    desc: "Let the past soften as it ages."
  }, /*#__PURE__*/React.createElement(Switch, {
    defaultChecked: true
  })), /*#__PURE__*/React.createElement(Row, {
    title: "Auto-archive after",
    desc: "Move quiet entries out of the way."
  }, /*#__PURE__*/React.createElement(Select, {
    options: ["30 days", "90 days", "1 year", "Never"],
    defaultValue: "90 days"
  })), /*#__PURE__*/React.createElement("h2", {
    style: {
      fontSize: "1.25rem",
      margin: "34px 0 12px"
    }
  }, "Plan"), /*#__PURE__*/React.createElement(Card, {
    variant: "flat"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontWeight: 600,
      color: "var(--text-strong)"
    }
  }, "Free plan"), /*#__PURE__*/React.createElement(Badge, {
    variant: "neutral"
  }, "Current")), /*#__PURE__*/React.createElement("p", {
    style: {
      color: "var(--text-muted)",
      fontSize: "0.875rem",
      marginTop: 4
    }
  }, "Unlimited entries \xB7 1 device")), /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    size: "sm",
    iconRight: AIco("arrow-up-right")
  }, "Upgrade")))));
}
Object.assign(window, {
  Settings
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/app/Settings.jsx", error: String((e && e.message) || e) }); }

// ui_kits/app/Sidebar.jsx
try { (() => {
/* Harbor app (Tidal) — left nav rail */
const {
  Avatar,
  IconButton,
  Badge,
  Tooltip
} = window.HarborDesignSystem_372bd7;
function Sidebar({
  folder,
  setFolder,
  view,
  setView,
  dark,
  setDark
}) {
  return /*#__PURE__*/React.createElement("nav", {
    style: {
      width: 232,
      flex: "none",
      background: "var(--surface)",
      borderRight: "1px solid var(--border)",
      display: "flex",
      flexDirection: "column",
      padding: "18px 14px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "4px 8px 18px"
    }
  }, /*#__PURE__*/React.createElement(AppLogo, null)), /*#__PURE__*/React.createElement("ul", {
    style: {
      listStyle: "none",
      margin: 0,
      padding: 0,
      display: "flex",
      flexDirection: "column",
      gap: 2
    }
  }, FOLDERS.map(f => {
    const active = view === "write" && folder === f.key;
    const count = ENTRIES.filter(e => f.key === "all" ? true : e.folder === f.key).length;
    return /*#__PURE__*/React.createElement("li", {
      key: f.key
    }, /*#__PURE__*/React.createElement("button", {
      onClick: () => {
        setFolder(f.key);
        setView("write");
      },
      style: {
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "9px 10px",
        borderRadius: "var(--radius-md)",
        border: 0,
        cursor: "pointer",
        background: active ? "var(--accent-soft)" : "transparent",
        color: active ? "var(--accent-soft-text)" : "var(--text)",
        fontFamily: "var(--font-sans)",
        fontSize: "0.925rem",
        fontWeight: 500,
        transition: "background var(--dur-fast) var(--ease-out)"
      }
    }, /*#__PURE__*/React.createElement("i", {
      "data-lucide": f.icon,
      style: {
        width: 17,
        height: 17
      }
    }), /*#__PURE__*/React.createElement("span", {
      style: {
        flex: 1,
        textAlign: "left"
      }
    }, f.label), /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        color: "var(--text-muted)"
      }
    }, count)));
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: "auto",
      paddingTop: 14,
      borderTop: "1px solid var(--border)",
      display: "flex",
      flexDirection: "column",
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setView("settings"),
    style: {
      width: "100%",
      display: "flex",
      alignItems: "center",
      gap: 10,
      padding: "9px 10px",
      borderRadius: "var(--radius-md)",
      border: 0,
      cursor: "pointer",
      background: view === "settings" ? "var(--accent-soft)" : "transparent",
      color: view === "settings" ? "var(--accent-soft-text)" : "var(--text)",
      fontFamily: "var(--font-sans)",
      fontSize: "0.925rem",
      fontWeight: 500
    }
  }, /*#__PURE__*/React.createElement("i", {
    "data-lucide": "settings",
    style: {
      width: 17,
      height: 17
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      textAlign: "left"
    }
  }, "Settings")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 10,
      padding: "8px 6px"
    }
  }, /*#__PURE__*/React.createElement(Avatar, {
    name: "Maya Okonkwo",
    size: "sm",
    status: "online"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "0.85rem",
      fontWeight: 600,
      color: "var(--text-strong)",
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis"
    }
  }, "Maya Okonkwo"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "0.72rem",
      color: "var(--text-muted)"
    }
  }, "Free plan")), /*#__PURE__*/React.createElement(Tooltip, {
    label: dark ? "Light mode" : "Dark mode"
  }, /*#__PURE__*/React.createElement(IconButton, {
    size: "sm",
    "aria-label": "Toggle theme",
    onClick: () => setDark(!dark)
  }, dark ? AIco("sun") : AIco("moon"))))));
}
Object.assign(window, {
  Sidebar
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/app/Sidebar.jsx", error: String((e && e.message) || e) }); }

// ui_kits/app/app.jsx
try { (() => {
/* Harbor app (Tidal) — shell: auth, layout, toast */
const {
  Toast
} = window.HarborDesignSystem_372bd7;
function TidalApp() {
  const [authed, setAuthed] = React.useState(false);
  const [dark, setDark] = React.useState(false);
  const [view, setView] = React.useState("write");
  const [folder, setFolder] = React.useState("today");
  const [entries, setEntries] = React.useState(ENTRIES);
  const [selectedId, setSelectedId] = React.useState(ENTRIES[0].id);
  const [toast, setToast] = React.useState(null);
  useLucideApp();
  React.useEffect(() => {
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  }, [dark]);
  const showToast = t => {
    setToast(t);
    clearTimeout(window.__hbT);
    window.__hbT = setTimeout(() => setToast(null), 3200);
  };
  const selected = entries.find(e => e.id === selectedId) || entries[0];
  const newEntry = () => {
    const id = "e" + Date.now();
    const e = {
      id,
      title: "Untitled",
      date: "Just now",
      folder: folder === "all" ? "today" : folder,
      tags: ["draft"],
      fade: 0,
      body: ""
    };
    setEntries([e, ...entries]);
    setSelectedId(id);
    setView("write");
    showToast({
      variant: "info",
      title: "New entry",
      msg: "A blank page, all yours."
    });
  };
  const save = title => {
    setEntries(entries.map(e => e.id === selectedId ? {
      ...e,
      title
    } : e));
    showToast({
      variant: "success",
      title: "Saved",
      msg: "Your entry is safe with the tide."
    });
  };
  if (!authed) return /*#__PURE__*/React.createElement(Login, {
    onEnter: () => setAuthed(true)
  });
  return /*#__PURE__*/React.createElement("div", {
    style: {
      height: "100vh",
      display: "flex",
      overflow: "hidden",
      background: "var(--bg)"
    }
  }, /*#__PURE__*/React.createElement(Sidebar, {
    folder: folder,
    setFolder: setFolder,
    view: view,
    setView: setView,
    dark: dark,
    setDark: setDark
  }), view === "settings" ? /*#__PURE__*/React.createElement(Settings, {
    dark: dark,
    setDark: setDark
  }) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(EntryList, {
    folder: folder,
    selectedId: selectedId,
    onSelect: setSelectedId,
    onNew: newEntry
  }), /*#__PURE__*/React.createElement(Editor, {
    entry: selected,
    onSave: save
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      position: "fixed",
      right: 24,
      bottom: 24,
      zIndex: 80,
      display: "flex",
      flexDirection: "column",
      gap: 10
    }
  }, toast ? /*#__PURE__*/React.createElement(Toast, {
    variant: toast.variant,
    title: toast.title,
    onClose: () => setToast(null)
  }, toast.msg) : null));
}
ReactDOM.createRoot(document.getElementById("root")).render(/*#__PURE__*/React.createElement(TidalApp, null));
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/app/app.jsx", error: String((e && e.message) || e) }); }

// ui_kits/app/data.jsx
try { (() => {
/* Harbor app (Tidal) — sample entries */
const ENTRIES = [{
  id: "e1",
  title: "Morning, low tide",
  date: "Today · 7:14",
  folder: "today",
  tags: ["morning"],
  fade: 0,
  body: "The water pulled back overnight and left the whole bay glassy. I walked out further than I meant to.\n\nStarted sketching the fade animation again — maybe entries shouldn't disappear, just settle."
}, {
  id: "e2",
  title: "On finishing things",
  date: "Yesterday",
  folder: "all",
  tags: ["work", "process"],
  fade: 0.15,
  body: "Shipped the smallest possible version of the editor today. It does one thing."
}, {
  id: "e3",
  title: "A list of small wins",
  date: "2 days ago",
  folder: "all",
  tags: ["notes"],
  fade: 0.3,
  body: "Coffee before screens. A real lunch. Closed three tabs and didn't reopen them."
}, {
  id: "e4",
  title: "Notes toward an essay",
  date: "Last week",
  folder: "drafts",
  tags: ["writing"],
  fade: 0.45,
  body: "Speed is a feeling, not a metric…"
}, {
  id: "e5",
  title: "Rainy window",
  date: "Last week",
  folder: "all",
  tags: ["morning"],
  fade: 0.55,
  body: "Didn't write much. That's allowed."
}, {
  id: "e6",
  title: "Old draft — sea glass",
  date: "Mar 2026",
  folder: "archive",
  tags: ["writing"],
  fade: 0.7,
  body: "Archived. Faded almost all the way out."
}];
const FOLDERS = [{
  key: "today",
  label: "Today",
  icon: "sun"
}, {
  key: "all",
  label: "All entries",
  icon: "book-open"
}, {
  key: "drafts",
  label: "Drafts",
  icon: "pen-line"
}, {
  key: "archive",
  label: "Archive",
  icon: "archive"
}];
Object.assign(window, {
  ENTRIES,
  FOLDERS
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/app/data.jsx", error: String((e && e.message) || e) }); }

// ui_kits/app/shared.jsx
try { (() => {
/* Harbor app (Tidal journal) — shared helpers */
function useLucideApp() {
  React.useEffect(() => {
    if (window.lucide) window.lucide.createIcons();
  });
}
const AIco = name => React.createElement("i", {
  "data-lucide": name
});
function AppLogo({
  size = 26
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: size + 7,
      height: size + 7,
      borderRadius: 8,
      display: "grid",
      placeItems: "center",
      background: "#fff",
      padding: 3,
      boxSizing: "border-box",
      boxShadow: "var(--shadow-xs)",
      border: "1px solid var(--border)"
    }
  }, /*#__PURE__*/React.createElement("img", {
    src: "../../assets/logo.png",
    alt: "Royal Forrest",
    style: {
      width: "100%",
      height: "100%",
      objectFit: "contain",
      display: "block"
    }
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-display)",
      fontWeight: 600,
      fontSize: size * 0.74,
      letterSpacing: "-0.02em",
      color: "var(--text-strong)"
    }
  }, "Royal Forrest"));
}
Object.assign(window, {
  useLucideApp,
  AIco,
  AppLogo
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/app/shared.jsx", error: String((e && e.message) || e) }); }

// ui_kits/portfolio/AboutScreen.jsx
try { (() => {
/* Harbor portfolio — About + contact */
const {
  Avatar,
  Button,
  Tag,
  Input
} = window.HarborDesignSystem_372bd7;
function AboutScreen() {
  const skills = ["Product design", "React", "TypeScript", "SwiftUI", "Type & layout", "Writing", "Design systems"];
  return /*#__PURE__*/React.createElement("main", null, /*#__PURE__*/React.createElement(Shell, {
    max: 760
  }, /*#__PURE__*/React.createElement("section", {
    style: {
      padding: "64px 0 48px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 18,
      marginBottom: 30
    }
  }, /*#__PURE__*/React.createElement(Avatar, {
    name: "Maya Okonkwo",
    size: "xl",
    status: "online"
  }), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(Eyebrow, null, "About"), /*#__PURE__*/React.createElement("h1", {
    style: {
      fontSize: "2.25rem",
      marginTop: 6,
      letterSpacing: "-0.02em"
    }
  }, "Maya Okonkwo"))), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "1.125rem",
      lineHeight: 1.7,
      color: "var(--text)",
      display: "flex",
      flexDirection: "column",
      gap: 18
    }
  }, /*#__PURE__*/React.createElement("p", null, "I'm a designer and developer who likes small tools and slow software. I care about interfaces that stay out of the way, type that reads well, and shipping things that feel finished rather than fast."), /*#__PURE__*/React.createElement("p", null, "Lately I've been building ", /*#__PURE__*/React.createElement("em", {
    style: {
      color: "var(--text-strong)"
    }
  }, "Tidal"), ", a journal that gently lets the past fade, and writing the ", /*#__PURE__*/React.createElement("em", {
    style: {
      color: "var(--text-strong)"
    }
  }, "Low Tide"), " essays. Before that, a long stretch of design-systems work for other people.")), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 34
    }
  }, /*#__PURE__*/React.createElement(Eyebrow, null, "Working with"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexWrap: "wrap",
      gap: 8,
      marginTop: 14
    }
  }, skills.map(s => /*#__PURE__*/React.createElement(Tag, {
    key: s
  }, s))))), /*#__PURE__*/React.createElement("section", {
    style: {
      borderTop: "1px solid var(--border)",
      padding: "44px 0 90px"
    }
  }, /*#__PURE__*/React.createElement("h2", {
    style: {
      fontSize: "1.75rem",
      marginBottom: 8
    }
  }, "Say hello"), /*#__PURE__*/React.createElement("p", {
    style: {
      color: "var(--text-muted)",
      marginBottom: 24
    }
  }, "For project work, writing, or just to talk shop. I read everything."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 12,
      alignItems: "flex-end",
      maxWidth: 520
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement(Input, {
    label: "Your email",
    type: "email",
    prefix: Ico("mail"),
    placeholder: "you@somewhere.com"
  })), /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    iconRight: Ico("arrow-up-right")
  }, "Send a note")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 18,
      marginTop: 30
    }
  }, [["github", "GitHub"], ["twitter", "Bluesky"], ["rss", "RSS"]].map(([ic, label]) => /*#__PURE__*/React.createElement("a", {
    key: label,
    href: "#",
    onClick: e => e.preventDefault(),
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: 7,
      color: "var(--text-muted)",
      fontSize: "0.95rem",
      fontWeight: 500
    }
  }, /*#__PURE__*/React.createElement("i", {
    "data-lucide": ic,
    style: {
      width: 17,
      height: 17
    }
  }), label))))));
}
Object.assign(window, {
  AboutScreen
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/portfolio/AboutScreen.jsx", error: String((e && e.message) || e) }); }

// ui_kits/portfolio/Header.jsx
try { (() => {
/* Harbor portfolio — sticky header with nav, theme toggle, contact CTA */
const {
  Button,
  IconButton,
  Tabs,
  Switch
} = window.HarborDesignSystem_372bd7;
function Header({
  route,
  setRoute,
  dark,
  setDark
}) {
  return /*#__PURE__*/React.createElement("header", {
    style: {
      position: "sticky",
      top: 0,
      zIndex: 30,
      background: "color-mix(in oklab, var(--bg) 78%, transparent)",
      backdropFilter: "blur(var(--blur-md))",
      WebkitBackdropFilter: "blur(var(--blur-md))",
      borderBottom: "1px solid var(--border)"
    }
  }, /*#__PURE__*/React.createElement(Shell, null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 24,
      height: 68
    }
  }, /*#__PURE__*/React.createElement(Wordmark, {
    onClick: () => setRoute("home")
  }), /*#__PURE__*/React.createElement("nav", {
    style: {
      marginLeft: "auto"
    }
  }, /*#__PURE__*/React.createElement(Tabs, {
    variant: "pill",
    value: route === "project" ? "work" : route,
    onChange: setRoute,
    items: [{
      value: "home",
      label: "Home"
    }, {
      value: "work",
      label: "Work"
    }, {
      value: "writing",
      label: "Writing"
    }, {
      value: "about",
      label: "About"
    }]
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 14
    }
  }, /*#__PURE__*/React.createElement("span", {
    title: "Toggle theme"
  }, /*#__PURE__*/React.createElement(Switch, {
    label: dark ? "Dark" : "Light",
    checked: dark,
    onChange: e => setDark(e.target.checked)
  })), /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    size: "sm",
    iconRight: Ico("arrow-up-right"),
    onClick: () => setRoute("about")
  }, "Say hello")))));
}
Object.assign(window, {
  Header
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/portfolio/Header.jsx", error: String((e && e.message) || e) }); }

// ui_kits/portfolio/HomeScreen.jsx
try { (() => {
/* Harbor portfolio — Home: hero, selected work, currently strip */
const {
  Button,
  Card,
  Badge,
  Tag
} = window.HarborDesignSystem_372bd7;
function ProjectCard({
  p,
  onOpen
}) {
  return /*#__PURE__*/React.createElement("div", {
    onClick: () => onOpen(p),
    style: {
      cursor: "pointer"
    }
  }, /*#__PURE__*/React.createElement(Card, {
    interactive: true,
    media: /*#__PURE__*/React.createElement(Cover, {
      icon: p.icon,
      tint: p.tint
    }),
    padding: "md"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "baseline",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("h3", {
    style: {
      fontSize: "1.375rem"
    }
  }, p.name), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: 12,
      color: "var(--text-muted)"
    }
  }, p.year)), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: "0.95rem",
      color: "var(--text-muted)",
      lineHeight: 1.55
    }
  }, p.blurb), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 6,
      marginTop: 6,
      flexWrap: "wrap"
    }
  }, /*#__PURE__*/React.createElement(Badge, {
    variant: "brand"
  }, p.kind), p.tags.map(t => /*#__PURE__*/React.createElement(Badge, {
    key: t,
    variant: "neutral"
  }, t)))));
}
function HomeScreen({
  setRoute,
  openProject
}) {
  return /*#__PURE__*/React.createElement("main", null, /*#__PURE__*/React.createElement("section", {
    style: {
      background: "linear-gradient(180deg, color-mix(in oklab, var(--blue-50) 70%, var(--bg)) 0%, var(--bg) 100%)",
      borderBottom: "1px solid var(--border)"
    }
  }, /*#__PURE__*/React.createElement(Shell, null, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "88px 0 80px",
      maxWidth: 760
    }
  }, /*#__PURE__*/React.createElement(Eyebrow, null, "Now \xB7 June 2026 \xB7 Lisbon"), /*#__PURE__*/React.createElement("h1", {
    style: {
      fontSize: "clamp(2.6rem, 5vw, 4rem)",
      lineHeight: 1.05,
      marginTop: 18,
      letterSpacing: "-0.025em"
    }
  }, "I make calm software", /*#__PURE__*/React.createElement("br", null), "and write about", /*#__PURE__*/React.createElement("br", null), /*#__PURE__*/React.createElement("span", {
    style: {
      fontStyle: "italic",
      fontWeight: 500,
      color: "var(--text-brand)"
    }
  }, "the process.")), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: "1.25rem",
      color: "var(--text)",
      maxWidth: 560,
      marginTop: 24,
      lineHeight: 1.6
    }
  }, "Designer and developer working on small, considered tools. Currently building Tidal and writing the Low Tide essays."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 12,
      marginTop: 32
    }
  }, /*#__PURE__*/React.createElement(Button, {
    variant: "primary",
    iconRight: Ico("arrow-right"),
    onClick: () => setRoute("work")
  }, "See the work"), /*#__PURE__*/React.createElement(Button, {
    variant: "secondary",
    iconLeft: Ico("feather"),
    onClick: () => setRoute("writing")
  }, "Read the notes"))))), /*#__PURE__*/React.createElement(Shell, null, /*#__PURE__*/React.createElement("section", {
    style: {
      padding: "72px 0"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "baseline",
      justifyContent: "space-between",
      marginBottom: 28
    }
  }, /*#__PURE__*/React.createElement("h2", {
    style: {
      fontSize: "1.75rem"
    }
  }, "Selected work"), /*#__PURE__*/React.createElement("button", {
    onClick: () => setRoute("work"),
    style: {
      background: "none",
      border: 0,
      cursor: "pointer",
      color: "var(--text-link)",
      fontFamily: "var(--font-sans)",
      fontSize: "0.95rem",
      fontWeight: 500,
      display: "inline-flex",
      alignItems: "center",
      gap: 6
    }
  }, "All work ", /*#__PURE__*/React.createElement("i", {
    "data-lucide": "arrow-up-right",
    style: {
      width: 15,
      height: 15
    }
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
      gap: 24
    }
  }, PROJECTS.slice(0, 3).map(p => /*#__PURE__*/React.createElement(ProjectCard, {
    key: p.id,
    p: p,
    onOpen: openProject
  }))))), /*#__PURE__*/React.createElement("section", {
    style: {
      borderTop: "1px solid var(--border)",
      background: "var(--surface)"
    }
  }, /*#__PURE__*/React.createElement(Shell, null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexWrap: "wrap",
      gap: 40,
      padding: "40px 0"
    }
  }, [["Reading", "book-open", "Tomas Tranströmer — selected poems"], ["Building", "anchor", "Tidal v0.4 — drafts & gentle decay"], ["Listening", "waves", "Field recordings of the Atlantic"]].map(([k, ic, v]) => /*#__PURE__*/React.createElement("div", {
    key: k,
    style: {
      flex: "1 1 220px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      color: "var(--text-brand)",
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement("i", {
    "data-lucide": ic,
    style: {
      width: 16,
      height: 16
    }
  }), /*#__PURE__*/React.createElement("span", {
    className: "harbor-eyebrow",
    style: {
      color: "var(--text-brand)"
    }
  }, k)), /*#__PURE__*/React.createElement("p", {
    style: {
      color: "var(--text-strong)",
      fontSize: "0.98rem"
    }
  }, v)))))));
}
Object.assign(window, {
  HomeScreen,
  ProjectCard
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/portfolio/HomeScreen.jsx", error: String((e && e.message) || e) }); }

// ui_kits/portfolio/ProjectScreen.jsx
try { (() => {
/* Harbor portfolio — Project detail */
const {
  Button,
  Badge,
  Tag
} = window.HarborDesignSystem_372bd7;
function ProjectScreen({
  project,
  back
}) {
  const p = project || PROJECTS[0];
  return /*#__PURE__*/React.createElement("main", null, /*#__PURE__*/React.createElement(Shell, {
    max: 860
  }, /*#__PURE__*/React.createElement("section", {
    style: {
      padding: "40px 0 0"
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: back,
    style: {
      background: "none",
      border: 0,
      cursor: "pointer",
      color: "var(--text-muted)",
      fontFamily: "var(--font-sans)",
      fontSize: "0.9rem",
      fontWeight: 500,
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
      marginBottom: 28
    }
  }, /*#__PURE__*/React.createElement("i", {
    "data-lucide": "arrow-left",
    style: {
      width: 15,
      height: 15
    }
  }), " All work"), /*#__PURE__*/React.createElement(Eyebrow, null, p.kind, " \xB7 ", p.year), /*#__PURE__*/React.createElement("h1", {
    style: {
      fontSize: "3rem",
      marginTop: 12,
      letterSpacing: "-0.03em"
    }
  }, p.name), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: "1.25rem",
      color: "var(--text)",
      maxWidth: 560,
      marginTop: 16,
      lineHeight: 1.55
    }
  }, p.blurb), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      marginTop: 18,
      flexWrap: "wrap"
    }
  }, p.tags.map(t => /*#__PURE__*/React.createElement(Badge, {
    key: t,
    variant: "neutral"
  }, t)))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 36,
      borderRadius: "var(--radius-xl)",
      overflow: "hidden",
      border: "1px solid var(--border)"
    }
  }, /*#__PURE__*/React.createElement(Cover, {
    icon: p.icon,
    ratio: "16 / 8",
    tint: p.tint
  })), /*#__PURE__*/React.createElement("section", {
    style: {
      padding: "44px 0 90px",
      display: "grid",
      gridTemplateColumns: "1fr 220px",
      gap: 48
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "1.0625rem",
      lineHeight: 1.75,
      color: "var(--text)",
      display: "flex",
      flexDirection: "column",
      gap: 18
    }
  }, /*#__PURE__*/React.createElement("p", {
    style: {
      fontFamily: "var(--font-display)",
      fontSize: "1.375rem",
      fontStyle: "italic",
      color: "var(--text-strong)",
      lineHeight: 1.45
    }
  }, "The brief was simple: a place to write that doesn't hoard everything you've ever typed."), /*#__PURE__*/React.createElement("p", null, p.name, " keeps the present sharp and lets older entries soften \u2014 visually and literally \u2014 until they're just a faint tideline at the bottom of the screen. The result is a journal that feels lighter the longer you use it."), /*#__PURE__*/React.createElement("p", null, "It's built with care and not much else: a small, legible interface, gentle motion, and exactly the features it needs. Nothing waits for a roadmap.")), /*#__PURE__*/React.createElement("aside", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 22
    }
  }, [["Role", "Design & build"], ["Year", p.year], ["Status", "Active"], ["Stack", p.tags.join(", ")]].map(([k, v]) => /*#__PURE__*/React.createElement("div", {
    key: k
  }, /*#__PURE__*/React.createElement("div", {
    className: "harbor-eyebrow",
    style: {
      marginBottom: 5
    }
  }, k), /*#__PURE__*/React.createElement("div", {
    style: {
      color: "var(--text-strong)",
      fontWeight: 500
    }
  }, v))), /*#__PURE__*/React.createElement(Button, {
    variant: "secondary",
    iconRight: Ico("arrow-up-right"),
    fullWidth: true
  }, "Visit project")))));
}
Object.assign(window, {
  ProjectScreen
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/portfolio/ProjectScreen.jsx", error: String((e && e.message) || e) }); }

// ui_kits/portfolio/WorkScreen.jsx
try { (() => {
/* Harbor portfolio — Work: filterable grid */
const {
  Tabs
} = window.HarborDesignSystem_372bd7;
function WorkScreen({
  openProject
}) {
  const [filter, setFilter] = React.useState("all");
  const kinds = ["all", ...Array.from(new Set(PROJECTS.map(p => p.kind)))];
  const shown = filter === "all" ? PROJECTS : PROJECTS.filter(p => p.kind === filter);
  return /*#__PURE__*/React.createElement("main", null, /*#__PURE__*/React.createElement(Shell, null, /*#__PURE__*/React.createElement("section", {
    style: {
      padding: "64px 0 28px"
    }
  }, /*#__PURE__*/React.createElement(Eyebrow, null, "Selected work \xB7 2024\u20132026"), /*#__PURE__*/React.createElement("h1", {
    style: {
      fontSize: "2.75rem",
      marginTop: 14,
      letterSpacing: "-0.025em"
    }
  }, "Things I've made"), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: "1.125rem",
      color: "var(--text-muted)",
      maxWidth: 520,
      marginTop: 14
    }
  }, "A few projects worth keeping around. Most are small on purpose."), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 28
    }
  }, /*#__PURE__*/React.createElement(Tabs, {
    value: filter,
    onChange: setFilter,
    items: kinds.map(k => ({
      value: k,
      label: k === "all" ? "All" : k
    }))
  }))), /*#__PURE__*/React.createElement("section", {
    style: {
      paddingBottom: 80
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
      gap: 24
    }
  }, shown.map(p => /*#__PURE__*/React.createElement(ProjectCard, {
    key: p.id,
    p: p,
    onOpen: openProject
  }))))));
}
Object.assign(window, {
  WorkScreen
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/portfolio/WorkScreen.jsx", error: String((e && e.message) || e) }); }

// ui_kits/portfolio/WritingScreen.jsx
try { (() => {
/* Harbor portfolio — Writing: notes list */
const {
  Badge,
  Tag
} = window.HarborDesignSystem_372bd7;
function WritingScreen() {
  return /*#__PURE__*/React.createElement("main", null, /*#__PURE__*/React.createElement(Shell, {
    max: 760
  }, /*#__PURE__*/React.createElement("section", {
    style: {
      padding: "64px 0 36px"
    }
  }, /*#__PURE__*/React.createElement(Eyebrow, null, "Writing \xB7 Low Tide"), /*#__PURE__*/React.createElement("h1", {
    style: {
      fontSize: "2.75rem",
      marginTop: 14,
      letterSpacing: "-0.025em"
    }
  }, "Notes from the coast"), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: "1.125rem",
      color: "var(--text-muted)",
      maxWidth: 520,
      marginTop: 14
    }
  }, "Short essays on building software slowly, design, and paying attention.")), /*#__PURE__*/React.createElement("section", {
    style: {
      paddingBottom: 90
    }
  }, /*#__PURE__*/React.createElement("ul", {
    style: {
      listStyle: "none",
      margin: 0,
      padding: 0
    }
  }, NOTES.map((n, i) => /*#__PURE__*/React.createElement("li", {
    key: n.id,
    style: {
      display: "flex",
      gap: 24,
      padding: "26px 0",
      borderTop: "1px solid var(--border)",
      borderBottom: i === NOTES.length - 1 ? "1px solid var(--border)" : "none"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: "none",
      width: 78,
      paddingTop: 4
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: 12,
      color: "var(--text-muted)"
    }
  }, n.date)), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("a", {
    href: "#",
    onClick: e => e.preventDefault(),
    style: {
      textDecoration: "none"
    }
  }, /*#__PURE__*/React.createElement("h3", {
    style: {
      fontSize: "1.5rem",
      marginBottom: 8
    }
  }, n.title)), /*#__PURE__*/React.createElement("p", {
    style: {
      color: "var(--text)",
      lineHeight: 1.6,
      marginBottom: 12
    }
  }, n.excerpt), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 10
    }
  }, n.tags.map(t => /*#__PURE__*/React.createElement(Badge, {
    key: t,
    variant: "neutral"
  }, t)), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: 11.5,
      color: "var(--text-muted)"
    }
  }, n.min, " min read")))))))));
}
Object.assign(window, {
  WritingScreen
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/portfolio/WritingScreen.jsx", error: String((e && e.message) || e) }); }

// ui_kits/portfolio/app.jsx
try { (() => {
/* Harbor portfolio — app shell: routing + theme + footer */
function App() {
  const [route, setRoute] = React.useState("home");
  const [project, setProject] = React.useState(null);
  const [dark, setDark] = React.useState(false);
  useLucide();
  React.useEffect(() => {
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  }, [dark]);
  const openProject = p => {
    setProject(p);
    setRoute("project");
    window.scrollTo(0, 0);
  };
  const go = r => {
    setRoute(r);
    window.scrollTo(0, 0);
  };
  let screen;
  if (route === "home") screen = /*#__PURE__*/React.createElement(HomeScreen, {
    setRoute: go,
    openProject: openProject
  });else if (route === "work") screen = /*#__PURE__*/React.createElement(WorkScreen, {
    openProject: openProject
  });else if (route === "writing") screen = /*#__PURE__*/React.createElement(WritingScreen, null);else if (route === "about") screen = /*#__PURE__*/React.createElement(AboutScreen, null);else if (route === "project") screen = /*#__PURE__*/React.createElement(ProjectScreen, {
    project: project,
    back: () => go("work")
  });
  return /*#__PURE__*/React.createElement("div", {
    style: {
      minHeight: "100vh",
      display: "flex",
      flexDirection: "column",
      background: "var(--bg)"
    }
  }, /*#__PURE__*/React.createElement(Header, {
    route: route,
    setRoute: go,
    dark: dark,
    setDark: setDark
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, screen), /*#__PURE__*/React.createElement("footer", {
    style: {
      borderTop: "1px solid var(--border)",
      background: "var(--surface)"
    }
  }, /*#__PURE__*/React.createElement(Shell, null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexWrap: "wrap",
      gap: 16,
      justifyContent: "space-between",
      alignItems: "center",
      padding: "28px 0"
    }
  }, /*#__PURE__*/React.createElement(Wordmark, {
    onClick: () => go("home")
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: 11,
      color: "var(--brand-teal-600)",
      letterSpacing: ".14em",
      textTransform: "uppercase"
    }
  }, "Calm from the storm")))));
}
ReactDOM.createRoot(document.getElementById("root")).render(/*#__PURE__*/React.createElement(App, null));
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/portfolio/app.jsx", error: String((e && e.message) || e) }); }

// ui_kits/portfolio/data.jsx
try { (() => {
/* Harbor portfolio — sample content */
const PROJECTS = [{
  id: "tidal",
  name: "Tidal",
  year: "2026",
  tint: "var(--blue-100)",
  icon: "book-open",
  kind: "Side project",
  blurb: "A calm weekly journal that fades the past gently.",
  tags: ["Product", "SwiftUI"]
}, {
  id: "ferry",
  name: "Ferry",
  year: "2025",
  tint: "#e7eef0",
  icon: "sailboat",
  kind: "Open source",
  blurb: "A tiny static-site builder for people who write in Markdown.",
  tags: ["CLI", "TypeScript"]
}, {
  id: "lowtide",
  name: "Low Tide",
  year: "2025",
  tint: "#e9eee9",
  icon: "waves",
  kind: "Writing",
  blurb: "An essay series on building software slowly and on purpose.",
  tags: ["Essays"]
}, {
  id: "compass",
  name: "Compass",
  year: "2024",
  tint: "#e4edf2",
  icon: "compass",
  kind: "Side project",
  blurb: "A bookmarking tool that remembers why you saved a thing.",
  tags: ["Web", "React"]
}];
const NOTES = [{
  id: "n1",
  date: "2026 · 06",
  title: "On building software slowly",
  excerpt: "Speed is a feeling, not a metric. A note on the quiet kind of progress that doesn't show up in a changelog.",
  tags: ["Process"],
  min: 6
}, {
  id: "n2",
  date: "2026 · 05",
  title: "The first note is the hardest",
  excerpt: "Why empty states deserve as much care as the busy ones — and a small pattern I keep reaching for.",
  tags: ["Design", "Writing"],
  min: 4
}, {
  id: "n3",
  date: "2026 · 03",
  title: "A palette is a mood, not a rule",
  excerpt: "Five colors from the coast, and what happened when I let them set the temperature of everything else.",
  tags: ["Color"],
  min: 5
}, {
  id: "n4",
  date: "2026 · 01",
  title: "Tools that get out of the way",
  excerpt: "The software I keep is the software I forget I'm using. Some thoughts on calm interfaces.",
  tags: ["Essays"],
  min: 7
}];
Object.assign(window, {
  PROJECTS,
  NOTES
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/portfolio/data.jsx", error: String((e && e.message) || e) }); }

// ui_kits/portfolio/shared.jsx
try { (() => {
/* Harbor portfolio — shared bits: icons, logo, placeholder media, layout shell */
const {
  IconButton,
  Switch
} = window.HarborDesignSystem_372bd7;
const Ico = (name, props = {}) => React.createElement("i", {
  "data-lucide": name,
  ...props
});

// Re-run lucide after every render so <i data-lucide> nodes become SVGs.
function useLucide() {
  React.useEffect(() => {
    if (window.lucide) window.lucide.createIcons();
  });
}
function Wordmark({
  onClick
}) {
  return /*#__PURE__*/React.createElement("button", {
    onClick: onClick,
    style: {
      display: "flex",
      alignItems: "center",
      gap: 11,
      background: "none",
      border: 0,
      cursor: "pointer",
      padding: 0
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 34,
      height: 34,
      borderRadius: 9,
      display: "grid",
      placeItems: "center",
      background: "#fff",
      padding: 3,
      boxSizing: "border-box",
      boxShadow: "var(--shadow-xs)",
      border: "1px solid var(--border)"
    }
  }, /*#__PURE__*/React.createElement("img", {
    src: "../../assets/logo.png",
    alt: "Royal Forrest",
    style: {
      width: "100%",
      height: "100%",
      objectFit: "contain",
      display: "block"
    }
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-display)",
      fontWeight: 600,
      fontSize: 21,
      letterSpacing: "-0.02em",
      color: "var(--text-strong)"
    }
  }, "Royal Forrest"));
}

/* Cool-toned placeholder for imagery (no generated images in the kit). */
function Cover({
  icon = "image",
  ratio = "16 / 10",
  tint = "var(--blue-100)",
  iconColor = "var(--blue-400)"
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      aspectRatio: ratio,
      background: tint,
      display: "grid",
      placeItems: "center",
      color: iconColor
    }
  }, /*#__PURE__*/React.createElement("i", {
    "data-lucide": icon,
    style: {
      width: 30,
      height: 30
    }
  }));
}
function Eyebrow({
  children
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: "harbor-eyebrow"
  }, children);
}
function Shell({
  children,
  max = 1080
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: max,
      margin: "0 auto",
      padding: "0 24px",
      width: "100%"
    }
  }, children);
}
Object.assign(window, {
  Ico,
  useLucide,
  Wordmark,
  Cover,
  Eyebrow,
  Shell
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/portfolio/shared.jsx", error: String((e && e.message) || e) }); }

__ds_ns.Avatar = __ds_scope.Avatar;

__ds_ns.Badge = __ds_scope.Badge;

__ds_ns.Button = __ds_scope.Button;

__ds_ns.Card = __ds_scope.Card;

__ds_ns.IconButton = __ds_scope.IconButton;

__ds_ns.Tag = __ds_scope.Tag;

__ds_ns.Toast = __ds_scope.Toast;

__ds_ns.Tooltip = __ds_scope.Tooltip;

__ds_ns.Checkbox = __ds_scope.Checkbox;

__ds_ns.Input = __ds_scope.Input;

__ds_ns.Select = __ds_scope.Select;

__ds_ns.Switch = __ds_scope.Switch;

__ds_ns.Tabs = __ds_scope.Tabs;

})();
