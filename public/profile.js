const uid = localStorage.getItem("uid");
const username = localStorage.getItem("username");

const userNameEl = document.getElementById("user-name");
const readListEl = document.getElementById("read-list");
const wantListEl = document.getElementById("want-list");
const readEmptyEl = document.getElementById("read-empty");
const wantEmptyEl = document.getElementById("want-empty");
const challengeForm = document.getElementById("challenge-form");
const joinChallengeForm = document.getElementById("join-challenge-form");
const challengeNameEl = document.getElementById("challenge-name");
const challengeDescriptionEl = document.getElementById("challenge-description");
const challengeCodeEl = document.getElementById("challenge-code");
const challengeMessageEl = document.getElementById("challenge-message");
const challengeListEl = document.getElementById("challenge-list");
const challengeEmptyEl = document.getElementById("challenge-empty");
const challengeDetailEl = document.getElementById("challenge-detail");

let selectedChallengeId = null;

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

function createChallengeCard(challenge) {
  const card = document.createElement("div");
  card.className = "challenge-card";

  const title = document.createElement("h5");
  title.textContent = challenge.name;

  const meta = document.createElement("p");
  meta.className = "challenge-card-meta";
  meta.textContent = `${challenge.book_count} books • ${challenge.member_count} members`;

  const code = document.createElement("p");
  code.className = "challenge-card-code";
  code.textContent = `Invite code: ${challenge.invite_code}`;

  const button = document.createElement("button");
  button.className = "action-btn";
  button.textContent =
    Number(challenge.challenge_id) === Number(selectedChallengeId) ? "Viewing" : "View challenge";
  button.disabled = Number(challenge.challenge_id) === Number(selectedChallengeId);
  button.addEventListener("click", () => {
    loadChallengeDetail(challenge.challenge_id);
  });

  card.appendChild(title);
  card.appendChild(meta);
  card.appendChild(code);

  if (challenge.description) {
    const description = document.createElement("p");
    description.className = "challenge-card-description";
    description.textContent = challenge.description;
    card.appendChild(description);
  }

  card.appendChild(button);
  return card;
}

function setChallengeMessage(text, color = "#2a5db0") {
  challengeMessageEl.textContent = text;
  challengeMessageEl.style.color = text ? color : "";
}

function ensureLoggedIn() {
  if (!uid) {
    window.location.href = "login.html";
    return false;
  }
  userNameEl.textContent = username ? `Hello, ${username}!` : "Hello!";
  return true;
}

function renderChallengeList(challenges) {
  challengeListEl.innerHTML = "";

  if (!Array.isArray(challenges) || challenges.length === 0) {
    challengeEmptyEl.textContent = "You have not created or joined any challenges yet.";
    return;
  }

  challengeEmptyEl.textContent = "";
  challenges.forEach((challenge) => {
    challengeListEl.appendChild(createChallengeCard(challenge));
  });
}

async function fetchChallenges() {
  const res = await fetch(`/api/challenges/user/${uid}`);
  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || "Unable to load challenges");
  }

  return data;
}

async function loadChallengeDetail(challengeId) {
  selectedChallengeId = challengeId;

  try {
    const res = await fetch(`/api/challenges/${challengeId}?uid=${encodeURIComponent(uid)}`);
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || "Unable to load challenge");
    }

    const memberItems = data.members.map((member) => `<li>${member.username}</li>`).join("");

    challengeDetailEl.innerHTML = `
      <div class="challenge-detail-card">
        <div class="challenge-detail-header">
          <div>
            <h4>${data.challenge.name}</h4>
            <p class="challenge-card-code">Invite code: ${data.challenge.invite_code}</p>
          </div>
          <p class="challenge-detail-meta">Created by ${data.challenge.creator_name}</p>
        </div>
        ${
          data.challenge.description
            ? `<p class="challenge-detail-description">${data.challenge.description}</p>`
            : ""
        }
        <div class="challenge-detail-columns">
          <section>
            <h5>Members</h5>
            <ul class="challenge-member-list">${memberItems}</ul>
          </section>
          <section>
            <h5>Challenge books</h5>
            <div id="challenge-book-grid" class="challenge-book-grid"></div>
          </section>
        </div>
      </div>
    `;

    const challengeBookGrid = document.getElementById("challenge-book-grid");
    if (data.books.length === 0) {
      challengeBookGrid.innerHTML = '<p class="challenge-empty">No books in this challenge yet.</p>';
    } else {
      data.books.forEach((book) => challengeBookGrid.appendChild(createBookCard(book)));
    }

    renderChallengeList(await fetchChallenges());
  } catch (error) {
    challengeDetailEl.innerHTML =
      '<p class="challenge-empty">Unable to load challenge details right now.</p>';
  }
}

async function loadChallenges(preferredChallengeId) {
  if (!ensureLoggedIn()) return;

  try {
    const challenges = await fetchChallenges();
    renderChallengeList(challenges);

    if (!Array.isArray(challenges) || challenges.length === 0) {
      challengeDetailEl.innerHTML = "";
      selectedChallengeId = null;
      return;
    }

    const challengeId = preferredChallengeId || selectedChallengeId || challenges[0].challenge_id;
    await loadChallengeDetail(challengeId);
  } catch (error) {
    challengeEmptyEl.textContent = "Unable to load challenges right now.";
    challengeDetailEl.innerHTML = "";
  }
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

challengeForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setChallengeMessage("");

  try {
    const res = await fetch("/api/challenges", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        uid: Number(uid),
        name: challengeNameEl.value.trim(),
        description: challengeDescriptionEl.value.trim(),
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      setChallengeMessage(data.error || "Unable to create challenge.", "red");
      return;
    }

    setChallengeMessage(
      `Challenge created. Share invite code ${data.invite_code} with your teammates.`,
      "green"
    );
    challengeForm.reset();
    await loadChallenges(data.challenge_id);
  } catch (error) {
    setChallengeMessage("Unable to create challenge right now.", "red");
  }
});

joinChallengeForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setChallengeMessage("");

  try {
    const res = await fetch("/api/challenges/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        uid: Number(uid),
        invite_code: challengeCodeEl.value.trim(),
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      setChallengeMessage(data.error || "Unable to join challenge.", "red");
      return;
    }

    setChallengeMessage(
      data.joined
        ? `Joined "${data.name}".`
        : `You are already a member of "${data.name}".`,
      "green"
    );
    joinChallengeForm.reset();
    await loadChallenges(data.challenge_id);
  } catch (error) {
    setChallengeMessage("Unable to join challenge right now.", "red");
  }
});

loadLibrary();
loadChallenges();
