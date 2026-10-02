// ---------- Starting data ----------
let notes = [
    { id: 1, text: "Buy milk and bread", category: "personal" },
    { id: 2, text: "Finish the Day 3 assignment", category: "study" },
    { id: 3, text: "Email the project report to Grace", category: "work" },
    { id: 4, text: "Revise JavaScript arrays", category: "study" },
    { id: 5, text: "Call mum", category: "personal" },
];

const VALID_CATEGORIES = ["personal", "work", "study"];

// ---------- Functions ----------

// Returns an array of notes whose text contains `word` (case-insensitive).
function searchNotes(word) {
    const search = String(word).toLowerCase();
    return notes.filter((note) => note.text.toLowerCase().includes(search));
}

// Returns the note with the most characters, or null if there are no notes.
function longestNote() {
    if (notes.length === 0) {
        return null;
    }
    let longest = notes[0];
    for (const note of notes) {
        if (note.text.length > longest.text.length) {
            longest = note;
        }
    }
    return longest;
}

// Returns an object counting notes per category.
function countByCategory() {
    const counts = {};
    for (const note of notes) {
        if (counts[note.category] === undefined) {
            counts[note.category] = 0;
        }
        counts[note.category]++;
    }
    return counts;
}

// Returns a sentence such as "5 notes: 2 personal, 1 work, 2 study."
function getSummary() {
    const counts = countByCategory();
    const total = notes.length;
    const label = total === 1 ? "note" : "notes";

    if (total === 0) {
        return `0 ${label}.`;
    }

    const parts = [];
    for (const category of VALID_CATEGORIES) {
        if (counts[category]) {
            parts.push(`${counts[category]} ${category}`);
        }
    }
    return `${total} ${label}: ${parts.join(", ")}.`;
}

// Makes text comparable: trimmed, lower-case, single spaces.
function normalise(text) {
    return String(text).trim().toLowerCase().replace(/\s+/g, " ");
}

// Returns true if a note with the same text already exists.
function isDuplicate(text) {
    const target = normalise(text);
    return notes.some((note) => normalise(note.text) === target);
}

// Adds a note if valid. Returns true when added, false otherwise.
function addNote(text, category) {
    if (typeof text !== "string") {
        console.log("addNote failed: text must be a string.");
        return false;
    }
    const cleanText = text.trim();

    if (cleanText.length < 1 || cleanText.length > 200) {
        console.log("addNote failed: text must be 1-200 characters.");
        return false;
    }
    if (isDuplicate(cleanText)) {
        console.log("addNote failed: duplicate note.");
        return false;
    }
    if (!VALID_CATEGORIES.includes(category)) {
        console.log("addNote failed: category must be personal, work or study.");
        return false;
    }

    const nextId = notes.reduce((max, note) => Math.max(max, note.id), 0) + 1;
    notes.push({ id: nextId, text: cleanText, category: category });
    return true;
}

// ---------- Tests ----------
// Each test shows the expected output in a comment.

console.log("--- searchNotes ---");
console.log(searchNotes("call"));
// [ { id: 5, text: 'Call mum', category: 'personal' } ]
console.log(searchNotes("JAVASCRIPT"));
// [ { id: 4, text: 'Revise JavaScript arrays', category: 'study' } ]
console.log(searchNotes("xyz"));
// []

console.log("--- longestNote ---");
console.log(longestNote());
// { id: 3, text: 'Email the project report to Grace', category: 'work' }
const savedNotes = notes; // keep the real array safe
notes = [];
console.log(longestNote());
// null
notes = savedNotes;

console.log("--- countByCategory ---");
console.log(countByCategory());
// { personal: 2, study: 2, work: 1 }
notes = [];
console.log(countByCategory());
// {}
notes = savedNotes;

console.log("--- getSummary ---");
console.log(getSummary());
// 5 notes: 2 personal, 1 work, 2 study.
notes = [savedNotes[4]];
console.log(getSummary());
// 1 note: 1 personal.
notes = [];
console.log(getSummary());
// 0 notes.
notes = savedNotes;

console.log("--- isDuplicate ---");
console.log(isDuplicate("buy milk and bread"));
// true
console.log(isDuplicate("   CALL    MUM   "));
// true
console.log(isDuplicate("Walk the dog"));
// false

console.log("--- addNote ---");
console.log(addNote("Walk the dog", "personal"));
// true
console.log(addNote("walk the dog", "personal"));
// addNote failed: duplicate note.
// false
console.log(addNote("", "work"));
// addNote failed: text must be 1-200 characters.
// false
console.log(addNote("a".repeat(201), "work"));
// addNote failed: text must be 1-200 characters.
// false
console.log(addNote("Plan a trip", "fun"));
// addNote failed: category must be personal, work or study.
// false

console.log("--- summary after adding ---");
console.log(getSummary());
// 6 notes: 3 personal, 1 work, 2 study.