// blimp's look for Chart.js and Mermaid (src/visuals/kit.ts). A page loads it after them and before its own
// scripts: it sets Chart.js's font, colours and tooltips from blimp.css, gives datasets with no colours of their own
// the kit's series colours, draws the page's <pre class="mermaid"> diagrams in blimp's colours, draws both again
// when the screen goes between light and dark, and keeps links from leaving the page.
(() => {
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const series = () => ["--c1", "--c2", "--c3", "--c4", "--c5", "--c6"].map(css);
  const tint = (hex, a) => {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  };
  const scheme = matchMedia("(prefers-color-scheme: dark)");

  // ---- Chart.js ----

  // Datasets this filled in, so a change of scheme fills them again; a page's own colours are never touched.
  const ours = new WeakSet();
  const colors = {
    id: "blimpColors",
    beforeUpdate(chart) {
      const c = series();
      const round = ["pie", "doughnut", "polarArea"].includes(chart.config.type);
      chart.data.datasets.forEach((d, i) => {
        if (!ours.has(d) && (d.backgroundColor || d.borderColor)) return;
        ours.add(d);
        if (round) {
          d.backgroundColor = d.data.map((_, j) => c[j % c.length]);
          d.borderColor = css("--bg");
        } else {
          const color = c[i % c.length];
          d.borderColor = color;
          d.backgroundColor = (d.type ?? chart.config.type) === "line" ? tint(color, 0.15) : color;
        }
      });
    },
  };

  function chartLook() {
    const C = window.Chart;
    if (!C) return;
    C.defaults.font.family = css("--font");
    C.defaults.font.size = 14;
    C.defaults.color = css("--fg-dim");
    C.defaults.borderColor = css("--line");
    // A tap shows the nearest point's values, so nothing needs a hover.
    C.defaults.interaction.mode = "nearest";
    C.defaults.interaction.intersect = false;
    const tip = C.defaults.plugins.tooltip;
    tip.backgroundColor = css("--bg-card");
    tip.titleColor = css("--fg");
    tip.bodyColor = css("--fg");
    tip.borderColor = css("--line");
    tip.borderWidth = 1;
    tip.padding = 10;
    tip.cornerRadius = 8;
    C.defaults.plugins.legend.labels.boxWidth = 12;
  }

  if (window.Chart) {
    window.Chart.register(colors);
    chartLook();
  }

  // ---- Mermaid ----

  const sources = new Map(); // each diagram's text, to draw it again in the other scheme

  async function drawDiagrams() {
    const M = window.mermaid;
    if (!M) return;
    const nodes = [...document.querySelectorAll("pre.mermaid")];
    if (!nodes.length) return;
    M.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      fontFamily: css("--font"),
      themeVariables: {
        darkMode: scheme.matches,
        fontFamily: css("--font"),
        fontSize: "15px",
        background: css("--bg"),
        primaryColor: css("--bg-card"),
        primaryTextColor: css("--fg"),
        primaryBorderColor: css("--c1"),
        secondaryColor: css("--bg-side"),
        tertiaryColor: css("--bg-side"),
        lineColor: css("--fg-faint"),
        textColor: css("--fg"),
        mainBkg: css("--bg-card"),
        nodeBorder: css("--c1"),
        clusterBkg: css("--bg-side"),
        clusterBorder: css("--fg-faint"),
        edgeLabelBackground: css("--bg"),
        noteBkgColor: css("--bg-side"),
        noteTextColor: css("--fg"),
        noteBorderColor: css("--fg-faint"),
        actorBkg: css("--bg-card"),
        actorBorder: css("--c1"),
        actorTextColor: css("--fg"),
        signalColor: css("--fg-dim"),
        signalTextColor: css("--fg"),
      },
    });
    for (const n of nodes) {
      if (!sources.has(n)) sources.set(n, n.textContent);
      n.removeAttribute("data-processed");
      n.textContent = sources.get(n);
    }
    try {
      await M.run({ nodes });
    } catch {} // a diagram with a mistake shows Mermaid's own error in its place
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", drawDiagrams);
  else drawDiagrams();

  scheme.addEventListener("change", () => {
    chartLook();
    if (window.Chart) for (const chart of Object.values(window.Chart.instances)) chart.update();
    drawDiagrams();
  });

  // ---- links ----

  // A visual has no internet, and leaving the page would only show an error where it was (the Mac's frame) or be
  // cancelled (the phone's web view): a tap on a link does nothing. Links within the page (#…) still scroll.
  document.addEventListener("click", (e) => {
    const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
    if (a && !a.getAttribute("href").startsWith("#")) e.preventDefault();
  });
})();
