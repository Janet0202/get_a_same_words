"""Local development server: python3 server.py."""
import json
import os
import secrets
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOMS = {}
LOCK = threading.Lock()
WEB = Path(__file__).parent / 'web'


def reset_game(room):
    room.update(phase='lobby', round=1, history=[], words={}, events=[], messages=[], next=set())
    room['revision'] = room.get('revision', 0) + 1


def advance(room):
    if len(room['players']) < 2:
        if room['phase'] != 'lobby':
            reset_game(room)
        return
    if room['phase'] == 'input' and all(p['id'] in room['words'] for p in room['players']):
        entries = [{'name': p['name'], 'word': room['words'][p['id']]} for p in room['players']]
        room['history'].append(entries)
        room['phase'] = 'finished' if len({p['word'] for p in entries}) == 1 else 'reveal'
        room['next'] = set()
    elif room['phase'] == 'reveal' and all(p['id'] in room.get('next', set()) for p in room['players']):
        room['round'] += 1
        room['words'] = {}
        room['phase'] = 'input'


def remove_player(room, token):
    room['players'] = [p for p in room['players'] if p['id'] != token]
    room['words'].pop(token, None)
    room.get('next', set()).discard(token)
    if not room['players']:
        ROOMS.pop(room['code'], None)
        return
    if room['host'] == token:
        room['host'] = room['players'][0]['id']
    advance(room)


def cleanup():
    now = time.monotonic()
    for room in list(ROOMS.values()):
        for player in list(room['players']):
            if now - player['seen'] > 90:
                remove_player(room, player['id'])


def public(room, token):
    return {
        'code': room['code'], 'phase': room['phase'], 'round': room['round'],
        'history': room['history'], 'host': token == room['host'],
        'revision': room.get('revision', 0),
        'ready': token in room.get('next', set()), 'readyCount': len(room.get('next', set())),
        'players': [{'key': p['key'], 'self': p['id'] == token, 'name': p['name'], 'submitted': p['id'] in room['words'],
                     'steps': p['steps']} for p in room['players']],
        'submitted': token in room['words'], 'events': room['events'][-12:],
        'messages': room['messages'],
    }


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB), **kwargs)

    def do_POST(self):
        try:
            size = int(self.headers.get('Content-Length', 0))
            if not 0 < size <= 4096:
                raise ValueError('请求过大或为空')
            data = json.loads(self.rfile.read(size))
            with LOCK:
                result = self.action(self.path, data)
            self.reply(200, result)
        except (ValueError, KeyError, TypeError) as error:
            self.reply(400, {'error': str(error)})

    def reply(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def action(self, path, data):
        cleanup()
        if path in ('/api/create', '/api/join'):
            if path == '/api/create':
                if len(ROOMS) >= 1000:
                    raise ValueError('房间已满，请稍后再试')
                code = secrets.token_hex(3).upper()
                while code in ROOMS:
                    code = secrets.token_hex(3).upper()
                ROOMS[code] = dict(code=code, players=[], phase='lobby', round=1,
                                   history=[], words={}, events=[], messages=[], host=None)
            if path == '/api/join':
                code = str(data.get('code', '')).upper().strip()
            room = ROOMS.get(code)
            if not room:
                raise ValueError('没有找到这个房间')
            if room['phase'] != 'lobby' or len(room['players']) >= 8:
                raise ValueError('房间已开始或已满，请创建新房间')
            used_names = {p['name'] for p in room['players']}
            names = [a + b for a in ('追风的', '发光的', '好奇的', '快乐的', '散步的', '勇敢的', '慢热的', '爱笑的')
                     for b in ('小兔', '小熊', '小猫', '狐狸', '熊猫', '青蛙', '考拉', '小鸭')]
            name = secrets.choice([n for n in names if n not in used_names])
            token = secrets.token_urlsafe(24)
            room['players'].append(dict(id=token, key=secrets.token_hex(8), name=name, steps=0, seen=time.monotonic()))
            room['host'] = room['host'] or token
            return dict(token=token, code=code, state=public(room, token))
        room = ROOMS.get(str(data.get('code', '')).upper())
        token = data.get('token')
        if not room or not any(p['id'] == token for p in room['players']):
            raise ValueError('房间或身份已失效，请重新加入')
        next(p for p in room['players'] if p['id'] == token)['seen'] = time.monotonic()
        if path == '/api/leave':
            remove_player(room, token)
            return {'left': True}
        if path in ('/api/restart', '/api/remove'):
            if token != room['host']:
                raise ValueError('只有房主可以管理房间')
            if path == '/api/restart':
                reset_game(room)
            else:
                target = next((p for p in room['players'] if p['key'] == data.get('player')), None)
                if not target or target['id'] == token:
                    raise ValueError('请选择其他玩家')
                remove_player(room, target['id'])
        elif path == '/api/start':
            if token != room['host'] or room['phase'] != 'lobby':
                raise ValueError('请等待房主开始')
            if len(room['players']) < 2:
                raise ValueError('至少需要两位玩家')
            room['phase'] = 'input'
        elif path == '/api/word':
            word = str(data.get('word', '')).strip()
            if room['phase'] != 'input' or token in room['words']:
                raise ValueError('本轮已经提交啦')
            if not word or len(word) > 20:
                raise ValueError('请输入 1～20 个字的词语')
            room['words'][token] = word
            advance(room)
        elif path == '/api/next':
            if room['phase'] != 'reveal':
                raise ValueError('当前不能进入下一轮')
            room['next'].add(token)
            advance(room)
        elif path == '/api/chat':
            text = data.get('text', '')
            if not isinstance(text, str) or not text.strip() or len(text.strip()) > 200:
                raise ValueError('请输入 1～200 个字的消息')
            player = next(p for p in room['players'] if p['id'] == token)
            now = time.monotonic()
            if now - player.get('last_chat', -1) < 1:
                raise ValueError('发送太快啦，请稍等一秒')
            if len(room['messages']) >= 500:
                raise ValueError('本局聊天已达 500 条上限，重新开局后可以继续')
            player['last_chat'] = now
            room['messages'].append(dict(id=secrets.token_hex(8), name=player['name'],
                                         text=text.strip(), round=room['round']))
        elif path == '/api/play':
            player = next(p for p in room['players'] if p['id'] == token)
            now = time.monotonic()
            if now - player.get('last_play', 0) >= 0.3:
                player['last_play'] = now
                player['steps'] += 1
                emoji = data.get('emoji', '👟')
                if emoji not in ['👟', '💡', '👏', '🤯', '✨']:
                    emoji = '👟'
                room['events'].append({'name': player['name'], 'emoji': emoji, 'id': secrets.token_hex(6)})
        elif path != '/api/state':
            raise ValueError('未知操作')
        result = public(room, token)
        result['ready'] = token in room.get('next', set())
        result['readyCount'] = len(room.get('next', set()))
        return result


if __name__ == '__main__':
    port = int(os.environ.get('PORT', '8000'))
    print(f'同词相逢 development server on port {port}', flush=True)
    ThreadingHTTPServer(('0.0.0.0', port), Handler).serve_forever()
