// Slack Socket Mode event types
export interface SlackSocketModeEvent {
  envelope_id: string;
  type: 'events_api' | 'interactive' | 'slash_commands' | 'disconnect' | 'hello';
  accepts_response_payload?: boolean;
  retry_attempt?: number;
  retry_reason?: string;
  payload?: SlackEventPayload;
}

export interface SlackEventPayload {
  token?: string;
  team_id?: string;
  api_app_id?: string;
  event?: SlackEvent;
  type?: string;
  event_id?: string;
  event_time?: number;
  authorizations?: SlackAuthorization[];
}

export interface SlackEvent {
  type: string;
  subtype?: string;
  user?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
  text?: string;
  reaction?: string;
  item?: SlackReactionItem;
  item_user?: string;
  event_ts?: string;
  channel_type?: string;
  bot_id?: string;
  files?: SlackFile[];
}

export interface SlackAuthorization {
  enterprise_id?: string;
  team_id: string;
  user_id: string;
  is_bot: boolean;
  is_enterprise_install: boolean;
}

export interface SlackReactionItem {
  type: 'message' | 'file' | 'file_comment';
  channel: string;
  ts: string;
}

// Slack API response types
export interface SlackApiResponse<_T = unknown> {
  ok: boolean;
  error?: string;
  warning?: string;
  response_metadata?: {
    next_cursor?: string;
    scopes?: string[];
    acceptedScopes?: string[];
  };
  // Data is spread directly on the response
  [key: string]: unknown;
}

export interface SlackMessage {
  type: 'message';
  subtype?: string;
  ts: string;
  user?: string;
  bot_id?: string;
  text: string;
  thread_ts?: string;
  reply_count?: number;
  reply_users_count?: number;
  latest_reply?: string;
  reply_users?: string[];
  is_locked?: boolean;
  subscribed?: boolean;
  reactions?: SlackReaction[];
  files?: SlackFile[];
  attachments?: SlackAttachment[];
  blocks?: SlackBlock[];
}

export interface SlackUser {
  id: string;
  team_id: string;
  name: string;
  deleted: boolean;
  real_name?: string;
  profile: SlackUserProfile;
  is_admin?: boolean;
  is_owner?: boolean;
  is_primary_owner?: boolean;
  is_restricted?: boolean;
  is_ultra_restricted?: boolean;
  is_bot?: boolean;
  is_app_user?: boolean;
  updated?: number;
}

export interface SlackUserProfile {
  title?: string;
  phone?: string;
  real_name?: string;
  real_name_normalized?: string;
  display_name?: string;
  display_name_normalized?: string;
  status_text?: string;
  status_emoji?: string;
  email?: string;
  image_24?: string;
  image_32?: string;
  image_48?: string;
  image_72?: string;
  image_192?: string;
  image_512?: string;
}

export interface SlackReaction {
  name: string;
  users: string[];
  count: number;
}

export interface SlackFile {
  id: string;
  name: string;
  title?: string;
  mimetype: string;
  filetype: string;
  size: number;
  url_private?: string;
  url_private_download?: string;
  permalink?: string;
  thumb_64?: string;
  thumb_80?: string;
  thumb_160?: string;
  thumb_360?: string;
  mode?: string;
  is_external?: boolean;
  external_type?: string;
}

export interface SlackAttachment {
  fallback?: string;
  color?: string;
  pretext?: string;
  author_name?: string;
  author_link?: string;
  author_icon?: string;
  title?: string;
  title_link?: string;
  text?: string;
  fields?: SlackAttachmentField[];
  image_url?: string;
  thumb_url?: string;
  footer?: string;
  footer_icon?: string;
  ts?: number;
}

export interface SlackAttachmentField {
  title: string;
  value: string;
  short: boolean;
}

export interface SlackBlock {
  type: string;
  block_id?: string;
  elements?: SlackBlockElement[];
  text?: SlackTextObject;
}

export interface SlackBlockElement {
  type: string;
  text?: SlackTextObject;
  action_id?: string;
  value?: string;
}

export interface SlackTextObject {
  type: 'plain_text' | 'mrkdwn';
  text: string;
  emoji?: boolean;
  verbatim?: boolean;
}

export interface SlackChannel {
  id: string;
  name: string;
  is_channel: boolean;
  is_group: boolean;
  is_im: boolean;
  is_mpim: boolean;
  is_private: boolean;
  is_archived: boolean;
  is_member?: boolean;
  topic?: { value: string; creator?: string; last_set?: number };
  purpose?: { value: string; creator?: string; last_set?: number };
  num_members?: number;
}

export interface SlackPin {
  type: string;
  created: number;
  created_by: string;
  message?: SlackMessage;
  channel?: string;
}

// API request/response types
export interface PostMessageRequest {
  channel: string;
  text?: string;
  thread_ts?: string;
  reply_broadcast?: boolean;
  unfurl_links?: boolean;
  unfurl_media?: boolean;
  mrkdwn?: boolean;
  blocks?: SlackBlock[];
  attachments?: SlackAttachment[];
}

export interface PostMessageResponse extends SlackApiResponse {
  channel: string;
  ts: string;
  message: SlackMessage;
}

export interface UpdateMessageRequest {
  channel: string;
  ts: string;
  text?: string;
  blocks?: SlackBlock[];
  attachments?: SlackAttachment[];
}

export interface UpdateMessageResponse extends SlackApiResponse {
  channel: string;
  ts: string;
  text: string;
}

export interface ConversationsRepliesResponse extends SlackApiResponse {
  messages: SlackMessage[];
  has_more: boolean;
}

export interface ConversationsHistoryResponse extends SlackApiResponse {
  messages: SlackMessage[];
  has_more: boolean;
  pin_count?: number;
  response_metadata?: {
    next_cursor: string;
  };
}

export interface ReactionsAddRequest {
  channel: string;
  timestamp: string;
  name: string;
}

export interface ReactionsRemoveRequest {
  channel: string;
  timestamp: string;
  name: string;
}

export interface UsersInfoResponse extends SlackApiResponse {
  user: SlackUser;
}

export interface UsersListResponse extends SlackApiResponse {
  members: SlackUser[];
  response_metadata?: {
    next_cursor: string;
  };
}

export interface AuthTestResponse extends SlackApiResponse {
  url: string;
  team: string;
  user: string;
  team_id: string;
  user_id: string;
  bot_id?: string;
  is_enterprise_install: boolean;
}

export interface AppsConnectionsOpenResponse extends SlackApiResponse {
  url: string;
}

export interface PinsListResponse extends SlackApiResponse {
  items: SlackPin[];
}

export interface FilesInfoResponse extends SlackApiResponse {
  file: SlackFile;
}
