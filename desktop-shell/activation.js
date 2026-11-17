const message = document.getElementById("message");
const key = document.getElementById("license-key");
const button = document.getElementById("activate");
message.textContent = new URLSearchParams(location.search).get("message") || "";

const logo = document.getElementById("logo");
logo.addEventListener("error", () => {
  if (!logo.dataset.fallback) { logo.dataset.fallback = "1"; logo.src = "../branding/UpdateX_Logo.png"; }
});

document.getElementById("activation-form").addEventListener("submit", async event => {
  event.preventDefault();
  button.disabled = true;
  message.classList.remove("success");
  message.textContent = "Checking your license locally…";
  try {
    const result = await window.updatePilotDesktop.activateLicense(key.value);
    key.value = "";
    if (result.startupError) { message.textContent = result.startupError; return; }
    message.classList.add("success");
    message.textContent = "License activated. Opening UpdateX…";
  } catch (error) {
    message.textContent = error.message || "Activation could not be completed.";
  } finally { button.disabled = false; }
});
