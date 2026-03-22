const toggleLogin = document.getElementById("toggle-login");
const toggleRegister = document.getElementById("toggle-register");
const form = document.getElementById("auth-form");
const submitBtn = document.getElementById("submit-btn");
const messageEl = document.getElementById("message");

let mode = "login";

function setMode(nextMode) {
  mode = nextMode;
  const isLogin = mode === "login";

  toggleLogin.classList.toggle("active-btn", isLogin);
  toggleRegister.classList.toggle("active-btn", !isLogin);
  submitBtn.textContent = isLogin ? "Login" : "Register";
  messageEl.textContent = "";
}

toggleLogin.addEventListener("click", () => setMode("login"));
toggleRegister.addEventListener("click", () => setMode("register"));

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  messageEl.textContent = "";

  const username = document.getElementById("username").value.trim();
  const password = document.getElementById("password").value.trim();

  if (!username || !password) {
    messageEl.textContent = "Please enter a username and password.";
    messageEl.style.color = "red";
    return;
  }

  const endpoint = mode === "login" ? "/api/login" : "/api/register";

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });

    const data = await res.json();

    if (!res.ok) {
      const fallback = mode === "login" ? "Invalid credentials" : "Registration failed";
      messageEl.textContent = data.error || fallback;
      messageEl.style.color = "red";
      return;
    }

    localStorage.setItem("uid", data.uid);
    localStorage.setItem("username", data.username || username);

    window.location.href = "index.html";
  } catch (error) {
    messageEl.textContent = "Something went wrong. Please try again.";
    messageEl.style.color = "red";
  }
});

setMode("login");
