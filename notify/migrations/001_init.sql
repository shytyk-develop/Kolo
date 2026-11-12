create table users (
    handle text primary key check (handle ~ '^[a-z0-9_]{3,20}$'),
    chat_id bigint not null unique,
    display_name text not null default '',
    lang text not null default 'en',
    bot_blocked boolean not null default false,
    created_at timestamptz not null default now()
);

-- single use, 10 minutes
create table link_tokens (
    token text primary key,
    expires_at timestamptz not null,
    used_at timestamptz,
    handle text references users (handle) on update cascade on delete cascade
);
create index link_tokens_expires on link_tokens (expires_at);

-- unordered pair
create table known_pairs (
    a text not null references users (handle) on update cascade on delete cascade,
    b text not null references users (handle) on update cascade on delete cascade,
    since timestamptz not null default now(),
    check (a <> b)
);
create unique index known_pairs_pair on known_pairs (least(a, b), greatest(a, b));
create index known_pairs_b on known_pairs (b);

create table blocks (
    blocker text not null references users (handle) on update cascade on delete cascade,
    blocked text not null references users (handle) on update cascade on delete cascade,
    created_at timestamptz not null default now(),
    primary key (blocker, blocked)
);
create index blocks_blocked on blocks (blocked);

-- target may not exist: kept anyway, it counts for rate limits
create table invites (
    id uuid primary key,
    caller text not null,
    caller_name text not null,
    target text not null,
    room text not null,
    -- had called before, at send time
    known boolean not null,
    chat_id bigint,
    message_id bigint,
    status text not null check (
        status in ('queued', 'sent', 'needs_acceptance', 'undeliverable', 'failed', 'void', 'blocked', 'ended')
    ),
    created_at timestamptz not null default now()
);
create index invites_caller_time on invites (caller, created_at);
create index invites_target on invites (target);
create index invites_chat on invites (chat_id);

-- the bot waits for an ID from this chat
create table chat_states (
    chat_id bigint primary key,
    step text not null check (step in ('choose', 'rename')),
    link_token text,
    updated_at timestamptz not null default now()
);
