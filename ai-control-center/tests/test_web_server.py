import json
import os
import threading
import unittest
from http.server import ThreadingHTTPServer
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from server import DashboardHandler

class DashboardServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd=ThreadingHTTPServer(("127.0.0.1",0),DashboardHandler)
        cls.thread=threading.Thread(target=cls.httpd.serve_forever,daemon=True); cls.thread.start()
        cls.base=f"http://127.0.0.1:{cls.httpd.server_port}"
    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown(); cls.httpd.server_close(); cls.thread.join(timeout=2)
    def test_health_endpoint(self):
        with urlopen(self.base+"/api/health") as response: data=json.loads(response.read())
        self.assertTrue(data["ok"]); self.assertEqual(data["service"],"ocode-ai-dashboard")
    def test_host_metrics_endpoint(self):
        with urlopen(self.base+"/api/metrics") as response: data=json.loads(response.read())
        self.assertTrue(data["ok"]); self.assertGreaterEqual(data["cpu_percent"],0)
        self.assertGreater(data["memory_total_gb"],0); self.assertGreaterEqual(data["disk_percent"],0)
    def test_index_served(self):
        with urlopen(self.base+"/") as response:
            self.assertIn("text/html",response.headers["Content-Type"]); self.assertIn(b"OCode",response.read())
    def test_unknown_route_is_404(self):
        with self.assertRaises(HTTPError) as caught: urlopen(self.base+"/not-found")
        self.assertEqual(caught.exception.code,404)
    def test_chat_rejects_empty_message(self):
        request=Request(self.base+"/api/chat",data=b'{"message":" "}',headers={"Content-Type":"application/json"})
        with self.assertRaises(HTTPError) as caught: urlopen(request)
        self.assertEqual(caught.exception.code,400)
    def test_chat_requires_provider_key(self):
        previous=os.environ.pop("AI_API_KEY",None)
        try:
            request=Request(self.base+"/api/chat",data=json.dumps({"message":"hello"}).encode(),headers={"Content-Type":"application/json"})
            with self.assertRaises(HTTPError) as caught: urlopen(request)
            self.assertEqual(caught.exception.code,503)
        finally:
            if previous is not None: os.environ["AI_API_KEY"]=previous
if __name__=="__main__": unittest.main()
