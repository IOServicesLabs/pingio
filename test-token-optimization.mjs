/**
 * Token Optimization Test Script
 * Compares old vs new response formats to verify token savings
 */

// Simulate old format responses
const oldFormats = {
  sendMessage: (recipient) => `Message sent to @${recipient}!`,
  addContact: (username) => `Added "${username}" to your contacts!\n\nYou can now send them messages with:\nsend_message(recipient="${username}", content="Hello!")`,
  listContacts: (contacts) => {
    const list = contacts.map(c => `- ${c.displayName} (@${c.username}) (${c.status}) [${c.unread} unread]`).join('\n');
    return `Your Contacts:\n\n${list}`;
  },
  getHistory: (contact, messages) => {
    const formatted = messages.map(m => {
      const time = new Date(m.time).toLocaleString();
      const prefix = m.isMe ? 'You' : m.sender;
      const edited = m.edited ? ' (edited)' : '';
      return `[${time}] ${prefix}: ${m.content}${edited}`;
    }).join('\n');
    return `Message history with @${contact}:\n\n${formatted}`;
  },
  blockContact: (username, block) => `${block ? 'Blocked' : 'Unblocked'} "${username}".`,
};

// New compact format responses
const newFormats = {
  sendMessage: (recipient) => `✓ @${recipient}`,
  addContact: (username) => `✓ @${username}`,
  listContacts: (contacts) => {
    return contacts.map(c => `${c.username} ${c.status} ${c.unread || ''}`.trim()).join('\n');
  },
  getHistory: (contact, messages) => {
    return messages.map(m => {
      const date = new Date(m.time);
      const time = `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
      return `${time} ${m.sender}: ${m.content}`;
    }).join('\n');
  },
  blockContact: (username, block) => `✓ ${block ? 'blocked' : 'unblocked'} @${username}`,
};

// Simple token estimation (1 token ≈ 4 chars for English, or split by whitespace/punctuation)
function estimateTokens(text) {
  // GPT-style tokenization approximation
  // Words + punctuation each count as roughly 1 token
  const tokens = text.split(/(\s+|\W+)/).filter(t => t.trim().length > 0);
  return tokens.length;
}

// Test data
const testContacts = [
  { username: 'alice', displayName: 'Alice', status: 'online', unread: 3 },
  { username: 'bob', displayName: 'Bob', status: 'away', unread: 0 },
  { username: 'carol', displayName: 'Carol', status: 'offline', unread: 0 },
];

const testMessages = [
  { sender: 'alice', content: 'Hello there!', time: Date.now() - 3600000, isMe: false, edited: false },
  { sender: 'testuser', content: 'Hi! How are you?', time: Date.now() - 3000000, isMe: true, edited: false },
  { sender: 'alice', content: 'Doing great, thanks!', time: Date.now() - 2400000, isMe: false, edited: false },
  { sender: 'testuser', content: 'Glad to hear it!', time: Date.now() - 1800000, isMe: true, edited: false },
  { sender: 'alice', content: 'See you later', time: Date.now() - 600000, isMe: false, edited: false },
];

console.log('='.repeat(70));
console.log('TOKEN OPTIMIZATION COMPARISON');
console.log('='.repeat(70));
console.log();

const comparisons = [
  { name: 'sendMessage', old: oldFormats.sendMessage('alice'), new: newFormats.sendMessage('alice') },
  { name: 'addContact', old: oldFormats.addContact('alice'), new: newFormats.addContact('alice') },
  { name: 'blockContact', old: oldFormats.blockContact('alice', true), new: newFormats.blockContact('alice', true) },
  { name: 'listContacts (3)', old: oldFormats.listContacts(testContacts), new: newFormats.listContacts(testContacts) },
  { name: 'getHistory (5 msgs)', old: oldFormats.getHistory('alice', testMessages), new: newFormats.getHistory('alice', testMessages) },
];

let totalOld = 0;
let totalNew = 0;

comparisons.forEach(({ name, old, new: newFmt }) => {
  const oldTokens = estimateTokens(old);
  const newTokens = estimateTokens(newFmt);
  const savings = oldTokens - newTokens;
  const percent = ((savings / oldTokens) * 100).toFixed(1);

  totalOld += oldTokens;
  totalNew += newTokens;

  console.log(`${name}:`);
  console.log(`  OLD (${oldTokens} tokens): ${old.replace(/\n/g, '\\n').substring(0, 60)}${old.length > 60 ? '...' : ''}`);
  console.log(`  NEW (${newTokens} tokens): ${newFmt.replace(/\n/g, '\\n').substring(0, 60)}${newFmt.length > 60 ? '...' : ''}`);
  console.log(`  Savings: ${savings} tokens (${percent}%)`);
  console.log();
});

console.log('='.repeat(70));
console.log('SUMMARY');
console.log('='.repeat(70));
console.log(`Total OLD: ${totalOld} tokens`);
console.log(`Total NEW: ${totalNew} tokens`);
console.log(`Total Savings: ${totalOld - totalNew} tokens (${(((totalOld - totalNew) / totalOld) * 100).toFixed(1)}%)`);
console.log();

// Show a full conversation simulation
console.log('='.repeat(70));
console.log('FULL CONVERSATION FLOW SIMULATION');
console.log('='.repeat(70));
console.log();
console.log('--- OLD FORMAT ---');
console.log(oldFormats.addContact('alice'));
console.log();
console.log(oldFormats.sendMessage('alice'));
console.log();
console.log(oldFormats.getHistory('alice', testMessages.slice(0, 3)));
console.log();
console.log('--- NEW FORMAT ---');
console.log(newFormats.addContact('alice'));
console.log(newFormats.sendMessage('alice'));
console.log(newFormats.getHistory('alice', testMessages.slice(0, 3)));
