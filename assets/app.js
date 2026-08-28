// Renders data/projects.json. The frontend is a pure function of that file --
// no GitHub API calls from the browser (anonymous visitors get 60 req/hr).
(function () {
  "use strict";

  var grid = document.getElementById("grid");
  var filters = document.getElementById("filters");
  var status = document.getElementById("status");
  var state = { projects: [], tag: null };

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    for (var k in attrs || {}) {
      if (k === "class") n.className = attrs[k];
      else if (k === "text") n.textContent = attrs[k];
      else if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }

  function links(p) {
    var box = el("div", { class: "links" });
    box.appendChild(el("a", { href: p.repo_url, text: "Source" }));
    if (p.demo_url) box.appendChild(el("a", { href: p.demo_url, text: "Live demo" }));
    return box;
  }

  function docList(docs) {
    var ul = el("ul", { class: "docs" });
    docs.forEach(function (d) {
      // raw.githubusercontent.com sends Content-Disposition: attachment, so
      // these download rather than navigate. It also blocks framing, which is
      // why there is no inline preview here.
      ul.appendChild(el("li", null, [
        el("a", { href: d.raw_url, download: "" }, [
          el("span", { class: "doc-main" }, [
            el("span", { class: "doc-title", text: d.title }),
            d.description ? el("span", { class: "doc-desc", text: d.description }) : null,
          ]),
          el("span", { class: "size", text: d.size_label || "" }),
        ]),
      ]));
    });
    return ul;
  }

  function card(p) {
    var isWritings = p.kind === "writings";
    var meta = el("div", { class: "meta" });
    if (p.language) meta.appendChild(el("span", { text: p.language }));
    if (p.stars) meta.appendChild(el("span", { text: "★ " + p.stars }));
    if (p.pushed_at) meta.appendChild(el("span", { text: "updated " + p.pushed_at.slice(0, 10) }));
    p.tags.forEach(function (t) { meta.appendChild(el("span", { class: "tag", text: t })); });

    return el("article", { class: "card" + (isWritings ? " card--writings" : "") }, [
      el("h2", null, [el("a", { href: p.repo_url, text: p.title })]),
      el("p", { class: "tagline", text: p.tagline }),
      p.description ? el("p", { class: "desc", text: p.description }) : null,
      meta,
      links(p),
      p.docs && p.docs.length ? docList(p.docs) : null,
    ]);
  }

  function render() {
    var list = state.tag
      ? state.projects.filter(function (p) { return p.tags.indexOf(state.tag) !== -1; })
      : state.projects;
    grid.textContent = "";
    if (!list.length) { grid.appendChild(el("p", { text: "Nothing to show." })); return; }
    list.forEach(function (p) { grid.appendChild(card(p)); });
    grid.setAttribute("aria-busy", "false");
  }

  function buildFilters() {
    var counts = {};
    state.projects.forEach(function (p) {
      p.tags.forEach(function (t) { counts[t] = (counts[t] || 0) + 1; });
    });
    var tags = Object.keys(counts).sort();
    if (!tags.length) return;
    filters.hidden = false;
    ["All"].concat(tags).forEach(function (label) {
      var tag = label === "All" ? null : label;
      var b = el("button", { type: "button", text: label });
      b.setAttribute("aria-pressed", String(state.tag === tag));
      b.addEventListener("click", function () {
        state.tag = tag;
        Array.prototype.forEach.call(filters.children, function (c) {
          c.setAttribute("aria-pressed", String(c === b));
        });
        render();
      });
      filters.appendChild(b);
    });
  }

  fetch("./data/projects.json", { cache: "no-cache" })
    .then(function (r) {
      if (!r.ok) throw new Error("projects.json returned " + r.status);
      return r.json();
    })
    .then(function (data) {
      state.projects = data.projects || [];
      var g = document.getElementById("generated");
      if (data.generated_at) g.textContent = new Date(data.generated_at).toLocaleString();
      buildFilters();
      render();
    })
    .catch(function (err) {
      grid.textContent = "";
      grid.appendChild(el("p", { text: "Could not load projects: " + err.message }));
    });
})();
