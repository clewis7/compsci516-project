function renderNav() {
  const nav = document.getElementById("site-nav");
  if (!nav) return;

  const uid = localStorage.getItem("uid");
  const username = localStorage.getItem("username");
  const profileIconUrl = localStorage.getItem("profile_icon_url");

  const logo = document.createElement("a");
  logo.href = "/";
  logo.className = "nav-logo";
  logo.textContent = "betterreads";

  const right = document.createElement("div");
  right.className = "nav-right";

  if (uid) {
    const profileLink = document.createElement("a");
    profileLink.href = "profile.html";
    profileLink.className = "nav-profile-link";

    const icon = document.createElement("img");
    icon.className = "nav-icon";
    icon.src = profileIconUrl || "/assets/icons/icon1.png";
    icon.alt = "Profile";
    icon.onerror = () => { icon.src = "/assets/icons/icon1.png"; };

    const name = document.createElement("span");
    name.textContent = username || "Profile";

    profileLink.appendChild(icon);
    profileLink.appendChild(name);

    const logoutBtn = document.createElement("button");
    logoutBtn.className = "action-btn nav-logout-btn";
    logoutBtn.textContent = "Logout";
    logoutBtn.addEventListener("click", () => {
      localStorage.removeItem("uid");
      localStorage.removeItem("username");
      localStorage.removeItem("profile_icon_url");
      window.location.href = "login.html";
    });

    right.appendChild(profileLink);
    right.appendChild(logoutBtn);
  } else {
    const loginLink = document.createElement("a");
    loginLink.href = "login.html";
    loginLink.className = "action-btn";
    loginLink.textContent = "Login / Register";
    right.appendChild(loginLink);
  }

  nav.appendChild(logo);
  nav.appendChild(right);
}

renderNav();
