/* docs.js — shared docs page enhancement script
 * - Injects dynamic version from /package.json into sidebar version spans
 * - Activates current nav link based on URL
 */
(function () {
  // ── Dynamic version injection ─────────────────────────────────────────
  fetch("/package.json")
    .then(function (r) { return r.ok ? r.json() : null; })
    .catch(function () { return null; })
    .then(function (pkg) {
      if (!pkg || !pkg.version) return;
      var v = "v" + pkg.version;
      document.querySelectorAll(".sidebar-version").forEach(function (el) {
        el.textContent = el.id === "current-version"
          ? "Current Version: " + v
          : "Docs Last Updated: " + v;
      });
    });

  // ── Active nav link ───────────────────────────────────────────────────
  var path = window.location.pathname.split("/").pop() || "index.html";
  document.querySelectorAll(".docs-sidebar a[href]").forEach(function (a) {
    var href = a.getAttribute("href").split("/").pop() || "index.html";
    if (href === path || (path === "" && href === "./") || (path === "index.html" && (href === "./" || href === ""))) {
      a.classList.add("active");
    } else {
      a.classList.remove("active");
    }
  });
})();
