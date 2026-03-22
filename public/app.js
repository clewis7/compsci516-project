async function searchBooks() {
  const searchInput = document.getElementById("searchInput");
  const resultsEl = document.getElementById("results");

  const q = searchInput.value.trim();
  const selectedRadio = document.querySelector(
    'input[name="searchField"]:checked',
  );
  const field = selectedRadio ? selectedRadio.value : "title";

  resultsEl.innerHTML = "";

  if (!q) {
    resultsEl.innerHTML = "<li>Please enter a search term.</li>";
    return;
  }

  try {
    const response = await fetch(
      `/api/search?q=${encodeURIComponent(q)}&field=${encodeURIComponent(field)}`,
    );

    if (!response.ok) {
      throw new Error("Search request failed");
    }

    const books = await response.json();

    if (!Array.isArray(books) || books.length === 0) {
      resultsEl.innerHTML = "<li>No results found.</li>";
      return;
    }

    books.forEach((book) => {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = `book.html?id=${book.book_id}`;
      a.textContent = `${book.title} by ${book.author}`;
      li.appendChild(a);
      resultsEl.appendChild(li);
    });
  } catch (error) {
    console.error("Search failed:", error);
    resultsEl.innerHTML = "<li>Something went wrong while searching.</li>";
  }
}

document.getElementById("searchInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    searchBooks();
  }
});

function renderAuthHeader() {
  const headerEl = document.getElementById("auth-header");
  if (!headerEl) return;

  const uid = localStorage.getItem("uid");
  const username = localStorage.getItem("username");

  headerEl.innerHTML = "";

  if (uid) {
    const text = document.createElement("span");
    text.textContent = "Logged in as ";

    const link = document.createElement("a");
    link.href = "profile.html";
    link.textContent = username || "User";

    const logoutBtn = document.createElement("button");
    logoutBtn.className = "action-btn";
    logoutBtn.textContent = "Logout";
    logoutBtn.addEventListener("click", () => {
      localStorage.removeItem("uid");
      localStorage.removeItem("username");
      window.location.href = "index.html";
    });

    headerEl.appendChild(text);
    headerEl.appendChild(link);
    headerEl.appendChild(logoutBtn);
  } else {
    const link = document.createElement("a");
    link.href = "login.html";
    link.textContent = "Login / Register";
    headerEl.appendChild(link);
  }
}

renderAuthHeader();
