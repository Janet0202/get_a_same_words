import time
import unittest
from unittest.mock import patch

from server import EXTRA_NICKNAMES, Handler, ROOMS


class RoomLifecycleTests(unittest.TestCase):
    def setUp(self):
        ROOMS.clear()
        self.handler = object.__new__(Handler)

    def call(self, action, identity=None, **data):
        return self.handler.action('/api/' + action, {**(identity or {}), **data})

    def players(self, count=3):
        host = self.call('create')
        return [host] + [self.call('join', code=host['code']) for _ in range(count - 1)]

    def test_departure_reveals_remaining_words_and_transfers_host(self):
        host, a, b = self.players()
        self.call('start', host)
        self.call('word', a, word='太阳')
        self.call('word', b, word='沙滩')
        self.call('leave', host)
        state = self.call('state', a)
        self.assertTrue(state['host'])
        self.assertEqual(state['phase'], 'reveal')
        self.assertEqual(len(state['history'][0]), 2)

    def test_departure_advances_ready_barrier(self):
        host, a, b = self.players()
        self.call('start', host)
        for player, word in zip((host, a, b), ('太阳', '沙滩', '海水')):
            self.call('word', player, word=word)
        self.call('next', host)
        self.call('next', a)
        self.call('leave', b)
        state = self.call('state', host)
        self.assertEqual((state['phase'], state['round']), ('input', 2))
        self.assertFalse(state['submitted'])

    def test_too_few_players_resets_and_can_start_again(self):
        host, a = self.players(2)
        self.call('start', host)
        self.call('word', host, word='夏天')
        self.call('leave', a)
        state = self.call('state', host)
        self.assertEqual(state['phase'], 'lobby')
        self.assertEqual(state['history'], [])
        self.assertFalse(state['submitted'])
        self.call('join', code=host['code'])
        self.assertEqual(self.call('start', host)['phase'], 'input')

    def test_restart_is_host_only_and_retains_room_and_players(self):
        host, a = self.players(2)
        self.call('start', host)
        self.call('word', host, word='夏天')
        with self.assertRaises(ValueError):
            self.call('restart', a)
        state = self.call('restart', host)
        self.assertEqual(state['code'], host['code'])
        self.assertEqual(state['phase'], 'lobby')
        self.assertEqual(len(state['players']), 2)
        self.assertFalse(state['submitted'])
        self.assertEqual(state['revision'], 1)

    def test_remove_is_host_only_and_invalidates_removed_session(self):
        host, a, b = self.players()
        key = host['state']['players'][0]['key']
        with self.assertRaises(ValueError):
            self.call('remove', a, player=key)
        with self.assertRaises(ValueError):
            self.call('remove', host, player=key)
        key = b['state']['players'][-1]['key']
        self.assertEqual(len(self.call('remove', host, player=key)['players']), 2)
        with self.assertRaises(ValueError):
            self.call('state', b)

    def test_timeout_removes_only_stale_player_and_releases_wait(self):
        host, a, b = self.players()
        self.call('start', host)
        self.call('word', host, word='夏天')
        self.call('word', a, word='夏天')
        ROOMS[host['code']]['players'][-1]['seen'] = time.monotonic() - 91
        state = self.call('state', host)
        self.assertEqual(state['phase'], 'finished')
        self.assertEqual(len(state['players']), 2)

    def test_last_departure_deletes_room(self):
        host = self.players(1)[0]
        self.call('leave', host)
        self.assertNotIn(host['code'], ROOMS)

    def test_chat_sync_isolation_and_restart(self):
        host, a = self.players(2)
        other = self.call('create')
        self.call('start', host)
        self.call('word', host, word='隐藏的词')
        self.call('chat', host, text='  我想到了海边 <script>  ')
        state = self.call('state', a)
        message = state['messages'][0]
        self.assertEqual(message['text'], '我想到了海边 <script>')
        self.assertEqual(message['name'], host['state']['players'][0]['name'])
        self.assertEqual(message['round'], 1)
        self.assertEqual(state['history'], [])
        self.assertEqual(self.call('state', other)['messages'], [])
        self.call('word', a, word='沙滩')
        self.call('next', host)
        self.call('next', a)
        self.assertEqual(len(self.call('state', a)['messages']), 1)
        self.assertEqual(self.call('restart', host)['messages'], [])

    def test_chat_validation_rate_limit_and_member_access(self):
        host, a = self.players(2)
        for text in (' ', '字' * 201, None, 123):
            with self.assertRaises(ValueError):
                self.call('chat', host, text=text)
        self.call('chat', host, text='字' * 200)
        with self.assertRaises(ValueError):
            self.call('chat', host, text='太快')
        self.call('leave', a)
        with self.assertRaises(ValueError):
            self.call('chat', a, text='已离开')
        with self.assertRaises(ValueError):
            self.call('chat', code=host['code'], token='invalid', text='访客')

    def test_chat_has_bounded_history(self):
        host = self.players(1)[0]
        room = ROOMS[host['code']]
        room['messages'] = [dict(id=str(i), name='测试', text='消息', round=1) for i in range(500)]
        with self.assertRaises(ValueError):
            self.call('chat', host, text='第501条')
        self.assertEqual(len(room['messages']), 500)

    def test_chat_retry_is_idempotent_and_scoped_to_sender(self):
        host, guest = self.players(2)
        first = self.call('chat', host, text='你好', client_id='retry-1')
        retry = self.call('chat', host, text='你好', client_id='retry-1')
        self.assertEqual(len(retry['messages']), 1)
        self.assertEqual(first['messages'][0]['id'], retry['messages'][0]['id'])
        self.assertGreater(retry['snapshot'], first['snapshot'])
        other = self.call('chat', guest, text='你好', client_id='retry-1')
        self.assertEqual(len(other['messages']), 2)

    def test_chat_rejects_message_from_previous_game(self):
        host = self.players(1)[0]
        self.call('restart', host)
        with self.assertRaises(ValueError):
            self.call('chat', host, text='旧局消息', revision=0)
        self.assertEqual(self.call('state', host)['messages'], [])

    def test_room_accepts_five_players_but_rejects_sixth(self):
        players = self.players(5)
        self.assertEqual(len(players[-1]['state']['players']), 5)
        with self.assertRaises(ValueError):
            self.call('join', code=players[0]['code'])

    def test_custom_nickname_weight_and_uniqueness(self):
        with patch('server.secrets.randbelow', return_value=79):
            players = self.players(5)
        names = [p['name'] for p in players[-1]['state']['players']]
        self.assertEqual(len(set(names)), 5)
        self.assertTrue(all(name in EXTRA_NICKNAMES for name in names))
        with patch('server.secrets.randbelow', return_value=80):
            normal = self.call('create')
        self.assertNotIn(normal['state']['players'][0]['name'], EXTRA_NICKNAMES)

    def test_distance_increases_on_mismatch_only_and_resets(self):
        host, a = self.players(2)
        self.assertEqual(host['state']['distance'], 0)
        self.call('start', host)
        for expected in (100, 200):
            self.call('word', host, word='太阳')
            self.assertEqual(self.call('word', a, word='沙滩')['distance'], expected)
            self.call('next', host)
            self.assertEqual(self.call('next', a)['distance'], expected)
        self.call('word', host, word='夏天')
        state = self.call('word', a, word='夏天')
        self.assertEqual(state['phase'], 'finished')
        self.assertEqual(state['distance'], 200)
        self.assertEqual(self.call('restart', host)['distance'], 0)


if __name__ == '__main__':
    unittest.main()
