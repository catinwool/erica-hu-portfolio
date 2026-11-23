const title = document.getElementById("title");
const status = document.getElementById("status");
const save = document.getElementById("save");
const open = document.getElementById("open");

function show(message, kind) {
  status.textContent = message;
  status.className = kind ? `status ${kind}` : "status";
}

function applyResult(result) {
  if (!result) {
    show("The shelf didn't answer.", "err");
    return;
  }
  if (result.locked) {
    title.textContent = "Unlock first";
    show(result.error || "Unlock Bookmark in Chrome, then try again.", "err");
    open.textContent = "Unlock";
    open.href = result.open || "https://bookmark.erica-hu.com/bookmark";
    save.disabled = false;
    return;
  }
  if (!result.ok) {
    title.textContent = "Not saved";
    show(result.error || "That page didn't go on the shelf.", "err");
    save.disabled = false;
    return;
  }
  const name = result.article?.title || "This page";
  title.textContent = result.refreshed ? "Updated" : result.duplicate ? "Already there" : "Saved";
  show(
    result.refreshed
      ? `${name} was refreshed with the page you had open.`
      : result.duplicate
        ? `${name} is already on the shelf.`
        : `${name} is on the shelf.`,
    "ok"
  );
  if (result.open) {
    open.textContent = "Read";
    open.href = result.open;
  }
  save.disabled = false;
}

async function runSave() {
  save.disabled = true;
  title.textContent = "Saving";
  show("Sending the page to your shelf…");
  try {
    const result = await chrome.runtime.sendMessage({ type: "save-active" });
    applyResult(result);
  } catch (error) {
    show(String(error && error.message ? error.message : error), "err");
    save.disabled = false;
  }
}

save.addEventListener("click", () => {
  runSave();
});

chrome.storage.session.get("lastSave").then((data) => {
  if (data.lastSave && Date.now() - (data.lastSave.at || 0) < 4000) {
    applyResult(data.lastSave);
    return;
  }
  runSave();
});
