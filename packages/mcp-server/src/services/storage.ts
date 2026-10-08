import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { LocalContact, LocalMessage, ChatSettings } from '../types/index.js';

const DATA_DIR = join(homedir(), '.pingio');
const CONTACTS_PATH = join(DATA_DIR, 'contacts.json');
const MESSAGES_PATH = join(DATA_DIR, 'messages.json');
const SETTINGS_PATH = join(DATA_DIR, 'settings.json');

export class StorageService {
  private contacts: Map<string, LocalContact> = new Map();
  private messages: Map<string, LocalMessage[]> = new Map();
  private settings: Map<string, ChatSettings> = new Map();

  constructor() {
    this.loadData();
  }

  private loadData(): void {
    try {
      if (existsSync(CONTACTS_PATH)) {
        const data = JSON.parse(readFileSync(CONTACTS_PATH, 'utf-8'));
        this.contacts = new Map(Object.entries(data));
      }
    } catch (error) {
      console.error('Failed to load contacts:', error);
    }

    try {
      if (existsSync(MESSAGES_PATH)) {
        const data = JSON.parse(readFileSync(MESSAGES_PATH, 'utf-8'));
        this.messages = new Map(Object.entries(data));
      }
    } catch (error) {
      console.error('Failed to load messages:', error);
    }

    try {
      if (existsSync(SETTINGS_PATH)) {
        const data = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
        this.settings = new Map(Object.entries(data));
      }
    } catch (error) {
      console.error('Failed to load settings:', error);
    }
  }

  saveData(): void {
    try {
      if (!existsSync(DATA_DIR)) {
        mkdirSync(DATA_DIR, { recursive: true });
      }

      // Convert Maps to objects for JSON serialization
      const contactsObj = Object.fromEntries(this.contacts);
      const messagesObj = Object.fromEntries(this.messages);
      const settingsObj = Object.fromEntries(this.settings);

      writeFileSync(CONTACTS_PATH, JSON.stringify(contactsObj, null, 2));
      writeFileSync(MESSAGES_PATH, JSON.stringify(messagesObj, null, 2));
      writeFileSync(SETTINGS_PATH, JSON.stringify(settingsObj, null, 2));
    } catch (error) {
      console.error('Failed to save data:', error);
    }
  }

  // Contact operations
  getContacts(): LocalContact[] {
    return Array.from(this.contacts.values());
  }

  getContact(userId: string): LocalContact | undefined {
    return this.contacts.get(userId);
  }

  saveContact(contact: LocalContact): void {
    this.contacts.set(contact.contactId, contact);
    this.saveData();
  }

  removeContact(userId: string): boolean {
    const result = this.contacts.delete(userId);
    if (result) this.saveData();
    return result;
  }

  // Message operations
  getMessages(chatId: string): LocalMessage[] {
    return this.messages.get(chatId) || [];
  }

  saveMessage(chatId: string, message: LocalMessage): void {
    if (!this.messages.has(chatId)) {
      this.messages.set(chatId, []);
    }
    const messages = this.messages.get(chatId)!;
    messages.push(message);

    // Keep only last 1000 messages per chat
    if (messages.length > 1000) {
      messages.splice(0, messages.length - 1000);
    }

    this.saveData();
  }

  updateMessage(chatId: string, messageId: string, updates: Partial<LocalMessage>): boolean {
    const messages = this.messages.get(chatId);
    if (!messages) return false;

    const index = messages.findIndex(m => m.id === messageId);
    if (index === -1) return false;

    messages[index] = { ...messages[index], ...updates };
    this.saveData();
    return true;
  }

  deleteMessage(chatId: string, messageId: string): boolean {
    const messages = this.messages.get(chatId);
    if (!messages) return false;

    const index = messages.findIndex(m => m.id === messageId);
    if (index === -1) return false;

    messages.splice(index, 1);
    this.saveData();
    return true;
  }

  clearMessages(chatId: string): boolean {
    const result = this.messages.delete(chatId);
    if (result) this.saveData();
    return result;
  }

  // Settings operations
  getChatSettings(chatId: string): ChatSettings | undefined {
    return this.settings.get(chatId);
  }

  setChatSettings(settings: ChatSettings): void {
    this.settings.set(settings.chatId, settings);
    this.saveData();
  }

  // Clear all data (for logout)
  clearAll(): void {
    this.contacts.clear();
    this.messages.clear();
    this.settings.clear();
    this.saveData();
  }
}

export const storageService = new StorageService();
