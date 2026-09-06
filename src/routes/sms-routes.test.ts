import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { registerSmsRoutes } from './sms-routes.js';
import type { ConversationService, Message, PaginatedConversations, Conversation } from '../services/conversation-service.js';

function createMockConversationService(): ConversationService {
  return {
    sendMessage: vi.fn(),
    receiveMessage: vi.fn(),
    updateMessageStatus: vi.fn(),
    retryMessage: vi.fn(),
    getConversations: vi.fn(),
    getMessages: vi.fn(),
    getThreadReadStates: vi.fn().mockResolvedValue(new Map()),
    getLastReceivedTimestamps: vi.fn().mockResolvedValue(new Map()),
  } as unknown as ConversationService;
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-uuid-1',
    provider_message_id: 'vonage-123',
    conversation_number: '+14155551234',
    provider_number: '+14155550000',
    body: 'Hello!',
    direction: 'SENT',
    status: 'SENT',
    timestamp: new Date('2024-01-15T10:30:00Z'),
    retry_count: 0,
    ...overrides,
  };
}

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    phone_number: '+14155551234',
    provider_number: '+14155550000',
    last_message_preview: 'Hello!',
    last_message_timestamp: new Date('2024-01-15T10:30:00Z'),
    created_at: new Date('2024-01-10T00:00:00Z'),
    ...overrides,
  };
}

describe('SMS Routes', () => {
  let server: FastifyInstance;
  let mockService: ConversationService;

  beforeEach(async () => {
    server = Fastify();
    mockService = createMockConversationService();
    registerSmsRoutes(server, mockService);
    await server.ready();
  });

  describe('POST /api/sms/send', () => {
    it('should return 201 with the created message on success', async () => {
      const mockMessage = makeMessage();
      (mockService.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue(mockMessage);

      const response = await server.inject({
        method: 'POST',
        url: '/api/sms/send',
        payload: { to: '+14155551234', body: 'Hello!', from: '+14155550000' },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.id).toBe('msg-uuid-1');
      expect(body.providerMessageId).toBe('vonage-123');
      expect(body.conversationNumber).toBe('+14155551234');
      expect(body.providerNumber).toBe('+14155550000');
      expect(body.body).toBe('Hello!');
      expect(body.direction).toBe('SENT');
      expect(body.status).toBe('SENT');
      expect(body.timestamp).toBe('2024-01-15T10:30:00.000Z');
      expect(body.retryCount).toBe(0);
      expect(mockService.sendMessage).toHaveBeenCalledWith('+14155550000', '+14155551234', 'Hello!');
    });

    it('should return 400 when to is missing', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/sms/send',
        payload: { body: 'Hello!', from: '+14155550000' },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error).toContain('Missing required fields');
    });

    it('should return 400 when body is missing', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/sms/send',
        payload: { to: '+14155551234', from: '+14155550000' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should return 400 when from is missing', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/sms/send',
        payload: { to: '+14155551234', body: 'Hello!' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should return 400 when message body is whitespace-only', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/api/sms/send',
        payload: { to: '+14155551234', body: '   ', from: '+14155550000' },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('Message body must not be whitespace-only');
    });

    it('should return FAILED status when provider fails', async () => {
      const failedMessage = makeMessage({ status: 'FAILED', provider_message_id: null });
      (mockService.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue(failedMessage);

      const response = await server.inject({
        method: 'POST',
        url: '/api/sms/send',
        payload: { to: '+14155551234', body: 'Test', from: '+14155550000' },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.status).toBe('FAILED');
    });
  });

  describe('GET /api/conversations', () => {
    it('should return paginated conversations with default params', async () => {
      const mockResult: PaginatedConversations = {
        conversations: [makeConversation()],
        page: 1,
        pageSize: 50,
        total: 1,
        totalPages: 1,
      };
      (mockService.getConversations as ReturnType<typeof vi.fn>).mockResolvedValue(mockResult);

      const response = await server.inject({
        method: 'GET',
        url: '/api/conversations',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.conversations).toHaveLength(1);
      expect(body.conversations[0].phoneNumber).toBe('+14155551234');
      expect(body.conversations[0].lastMessagePreview).toBe('Hello!');
      expect(body.conversations[0].lastMessageTimestamp).toBe('2024-01-15T10:30:00.000Z');
      expect(body.conversations[0].createdAt).toBe('2024-01-10T00:00:00.000Z');
      expect(body.conversations[0].lastReceivedAt).toBeNull();
      expect(body.conversations[0].lastReadAt).toBeNull();
      expect(body.page).toBe(1);
      expect(body.pageSize).toBe(50);
      expect(body.total).toBe(1);
      expect(body.totalPages).toBe(1);
      expect(mockService.getConversations).toHaveBeenCalledWith(1, 50, undefined);
    });

    it('should pass custom page and pageSize from query params', async () => {
      const mockResult: PaginatedConversations = {
        conversations: [],
        page: 2,
        pageSize: 25,
        total: 0,
        totalPages: 0,
      };
      (mockService.getConversations as ReturnType<typeof vi.fn>).mockResolvedValue(mockResult);

      const response = await server.inject({
        method: 'GET',
        url: '/api/conversations?page=2&pageSize=25',
      });

      expect(response.statusCode).toBe(200);
      expect(mockService.getConversations).toHaveBeenCalledWith(2, 25, undefined);
    });

    it('should handle null lastMessageTimestamp', async () => {
      const mockResult: PaginatedConversations = {
        conversations: [makeConversation({ last_message_timestamp: null })],
        page: 1,
        pageSize: 50,
        total: 1,
        totalPages: 1,
      };
      (mockService.getConversations as ReturnType<typeof vi.fn>).mockResolvedValue(mockResult);

      const response = await server.inject({
        method: 'GET',
        url: '/api/conversations',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.conversations[0].lastMessageTimestamp).toBeNull();
    });
  });

  describe('GET /api/conversations/:number', () => {
    it('should return messages for a conversation thread', async () => {
      const mockMessages = [
        makeMessage({ id: 'msg-1', body: 'First', direction: 'SENT' }),
        makeMessage({ id: 'msg-2', body: 'Reply', direction: 'RECEIVED', status: 'DELIVERED' }),
      ];
      (mockService.getMessages as ReturnType<typeof vi.fn>).mockResolvedValue(mockMessages);

      const response = await server.inject({
        method: 'GET',
        url: '/api/conversations/%2B14155551234',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.phoneNumber).toBe('+14155551234');
      expect(body.messages).toHaveLength(2);
      expect(body.messages[0].id).toBe('msg-1');
      expect(body.messages[0].body).toBe('First');
      expect(body.messages[0].direction).toBe('SENT');
      expect(body.messages[1].id).toBe('msg-2');
      expect(body.messages[1].body).toBe('Reply');
      expect(body.messages[1].direction).toBe('RECEIVED');
      expect(mockService.getMessages).toHaveBeenCalledWith('+14155551234', 100, undefined);
    });

    it('should scope messages to a provider thread when `from` is supplied', async () => {
      (mockService.getMessages as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await server.inject({
        method: 'GET',
        url: '/api/conversations/%2B14155551234?from=%2B14155550000&limit=50',
      });

      expect(mockService.getMessages).toHaveBeenCalledWith('+14155551234', 50, '+14155550000');
    });

    it('should return empty messages array for a thread with no messages', async () => {
      (mockService.getMessages as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const response = await server.inject({
        method: 'GET',
        url: '/api/conversations/%2B14155559999',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.messages).toEqual([]);
    });

    it('should properly decode URL-encoded phone numbers', async () => {
      (mockService.getMessages as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await server.inject({
        method: 'GET',
        url: '/api/conversations/%2B447911123456',
      });

      expect(mockService.getMessages).toHaveBeenCalledWith('+447911123456', 100, undefined);
    });
  });
});
