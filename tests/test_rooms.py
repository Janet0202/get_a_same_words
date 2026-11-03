import time
import unittest

from server import Handler, ROOMS


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


if __name__ == '__main__':
    unittest.main()
