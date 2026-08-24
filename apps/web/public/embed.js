/**
 * NeuroClaw Growth — Embed Loader
 * ---------------------------------------------------------------------------
 * "We live in your ecosystem": drop this script into any partner site to embed
 * the full NeuroClaw Growth flow (onboarding → templates → runs → results)
 * inside an auto-resizing iframe.
 *
 * Usage:
 *   <div id="neuroclaw-root"></div>
 *   <script
 *     src="https://your-neuroclaw-host/embed.js"
 *     data-target="neuroclaw-root"
 *     data-mode="onboarding"
 *   ></script>
 *
 * The host page stays in control: NeuroClaw never touches parent DOM beyond
 * the mount node, communicates only via PostMessage, and inherits nothing.
 */
(function () {
  "use strict";

  var script =
    document.currentScript ||
    (function () {
      var all = document.getElementsByTagName("script");
      return all[all.length - 1];
    })();

  var targetId = script.getAttribute("data-target") || "neuroclaw-root";
  var mode = script.getAttribute("data-mode") || "onboarding";
  var host = script.getAttribute("data-host") || new URL(script.src).origin;
  var height = script.getAttribute("data-height") || "720";

  var mount = document.getElementById(targetId);
  if (!mount) {
    console.warn("[neuroclaw-embed] target #" + targetId + " not found");
    return;
  }

  var allowedModes = { onboarding: "/onboarding", templates: "/templates" };
  var path = allowedModes[mode] || "/onboarding";
  var src = host + "/?embed=1#" + path;

  var iframe = document.createElement("iframe");
  iframe.src = src;
  iframe.title = "NeuroClaw Growth";
  iframe.setAttribute("allow", "clipboard-write");
  iframe.style.width = "100%";
  iframe.style.height = height + "px";
  iframe.style.border = "0";
  iframe.style.borderRadius = "18px";
  iframe.style.background = "#0b0a09";

  mount.appendChild(iframe);

  // Auto-height sync — the embedded app posts its scrollHeight on mutations.
  window.addEventListener("message", function (event) {
    if (event.origin !== host) return;
    var data = event.data || {};
    if (data.type === "neuroclaw:resize" && typeof data.height === "number") {
      iframe.style.height = Math.max(480, data.height) + "px";
    }
  });
})();
