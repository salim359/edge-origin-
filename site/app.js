(function () {
  const editBtn = document.getElementById("edit-btn");
  const stampBtn = document.getElementById("stamp-btn");
  const output = document.getElementById("stamp-output");
  const fields = document.querySelectorAll("[data-field]");

  if (!editBtn || !stampBtn || !output) {
    return;
  }

  let editing = false;
  let content = {
    title: "",
    body: "",
  };

  function setStatus(message, ok) {
    output.classList.remove("is-stamped", "is-error");
    void output.offsetWidth;
    output.textContent = message;
    output.classList.add(ok ? "is-stamped" : "is-error");
  }

  function applyContent(data) {
    content = {
      title: data.title || "",
      body: data.body || "",
    };
    fields.forEach(function (el) {
      const key = el.getAttribute("data-field");
      if (!key || !(key in content)) {
        return;
      }
      el.textContent = content[key];
    });
  }

  function readContentFromDom() {
    const next = {};
    fields.forEach(function (el) {
      const key = el.getAttribute("data-field");
      if (!key) {
        return;
      }
      next[key] = el.textContent.trim();
    });
    content = Object.assign({}, content, next);
    return content;
  }

  function setEditing(on) {
    editing = on;
    document.body.classList.toggle("is-editing", on);
    editBtn.textContent = on ? "Done editing" : "Edit notes";
    editBtn.setAttribute("aria-pressed", on ? "true" : "false");
    fields.forEach(function (el) {
      el.contentEditable = on ? "true" : "false";
      el.spellcheck = on;
    });
    if (on && fields[0]) {
      fields[0].focus();
    }
  }

  editBtn.addEventListener("click", function () {
    if (editing) {
      readContentFromDom();
    }
    setEditing(!editing);
  });

  stampBtn.addEventListener("click", async function () {
    const publishUrl =
      (window.SITE_CONFIG && window.SITE_CONFIG.publishUrl) || "";

    if (!publishUrl || publishUrl.indexOf("REPLACE_") === 0) {
      setStatus(
        "Publish URL missing. Deploy the stack, then sync site/config.js.",
        false
      );
      return;
    }

    readContentFromDom();
    if (editing) {
      setEditing(false);
    }

    stampBtn.disabled = true;
    stampBtn.textContent = "Publishing…";
    setStatus("Uploading content.json and creating invalidation…", true);

    try {
      const res = await fetch(publishUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: content }),
      });

      const data = await res.json().catch(function () {
        return {};
      });

      if (!res.ok) {
        throw new Error(data.error || "Publish failed (" + res.status + ")");
      }

      setStatus(
        "Uploaded content.json · invalidation " +
          data.invalidationId +
          " (" +
          data.status +
          "). Hard-refresh in a minute.",
        true
      );
    } catch (err) {
      setStatus(String(err.message || err), false);
    } finally {
      stampBtn.disabled = false;
      stampBtn.textContent = "Stamp (upload + invalidate)";
    }
  });

  fetch("content.json", { cache: "no-store" })
    .then(function (res) {
      if (!res.ok) {
        throw new Error("Could not load content.json (" + res.status + ")");
      }
      return res.json();
    })
    .then(applyContent)
    .catch(function (err) {
      setStatus(String(err.message || err), false);
    });
})();
