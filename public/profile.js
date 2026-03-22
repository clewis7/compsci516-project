const uid = localStorage.getItem("uid");
const username = localStorage.getItem("username");

const userNameEl = document.getElementById("user-name");
const readListEl = document.getElementById("read-list");
const wantListEl = document.getElementById("want-list");
const readEmptyEl = document.getElementById("read-empty");
const wantEmptyEl = document.getElementById("want-empty");

function createBookCard(book) {
  const card = document.createElement("div");
  card.style.width = "150px";
  card.style.textAlign = "center";

  const link = document.createElement("a");
  link.href = `book.html?id=${book.book_id}`;
  link.style.textDecoration = "none";
  link.style.color = "#333";

  const img = document.createElement("img");
  img.src = book.cover_image_url || "";
  img.alt = book.title;
  img.style.width = "120px";
  img.style.height = "180px";
  img.style.objectFit = "cover";
  img.style.borderRadius = "4px";
  img.style.border = "1px solid #ddd";

  const title = document.createElement("p");
  title.textContent = book.title;
  title.style.fontSize = "13px";
  title.style.fontWeight = "bold";
  title.style.margin = "8px 0 0";

  link.appendChild(img);
  link.appendChild(title);
  card.appendChild(link);

  return card;
}

function ensureLoggedIn() {
  if (!uid) {
    window.location.href = "login.html";
    return false;
  }
  userNameEl.textContent = username ? `Hello, ${username}!` : "Hello!";
  return true;
}

async function loadLibrary() {
  if (!ensureLoggedIn()) return;

  try {
    const res = await fetch(`/api/user/${uid}/library`);
    const data = await res.json();

    const readBooks = data.read_books || [];
    const wantBooks = data.want_to_read || [];

    readListEl.innerHTML = "";
    wantListEl.innerHTML = "";

    if (readBooks.length === 0) {
      readEmptyEl.textContent = "You haven't added any books yet.";
    } else {
      readEmptyEl.textContent = "";
      readBooks.forEach((book) => readListEl.appendChild(createBookCard(book)));
    }

    if (wantBooks.length === 0) {
      wantEmptyEl.textContent = "You haven't added any books yet.";
    } else {
      wantEmptyEl.textContent = "";
      wantBooks.forEach((book) => wantListEl.appendChild(createBookCard(book)));
    }
  } catch (error) {
    readEmptyEl.textContent = "Unable to load your library right now.";
    wantEmptyEl.textContent = "";
  }
}

document.getElementById("logout-btn").addEventListener("click", () => {
  localStorage.removeItem("uid");
  localStorage.removeItem("username");
  window.location.href = "login.html";
});

loadLibrary();
