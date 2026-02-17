#!/usr/bin/env python3
import requests
import sys
import json
from datetime import datetime

# Use the external URL from frontend .env
API_BASE = "https://55eaebb0-ff20-4cea-8b0f-f4e668da1934.preview.emergentagent.com"

class FlashBotAPITester:
    def __init__(self, base_url=API_BASE):
        self.base_url = base_url
        self.tests_run = 0
        self.tests_passed = 0
        self.failed_tests = []

    def run_test(self, name, method, endpoint, expected_status=200, data=None, headers=None):
        """Run a single API test"""
        url = f"{self.base_url}{endpoint}"
        if headers is None:
            headers = {'Content-Type': 'application/json'}

        self.tests_run += 1
        print(f"\n🔍 Testing {name}...")
        print(f"   URL: {url}")
        
        try:
            if method == 'GET':
                response = requests.get(url, headers=headers, timeout=10)
            elif method == 'POST':
                response = requests.post(url, json=data, headers=headers, timeout=10)
            elif method == 'PUT':
                response = requests.put(url, json=data, headers=headers, timeout=10)
            elif method == 'DELETE':
                response = requests.delete(url, headers=headers, timeout=10)

            success = response.status_code == expected_status
            if success:
                self.tests_passed += 1
                print(f"✅ PASS - Status: {response.status_code}")
                try:
                    response_json = response.json()
                    print(f"   Response keys: {list(response_json.keys()) if isinstance(response_json, dict) else 'Array/Value'}")
                    return True, response_json
                except json.JSONDecodeError:
                    print(f"   Response: {response.text[:100]}...")
                    return True, response.text
            else:
                self.failed_tests.append({
                    'test': name, 
                    'expected': expected_status, 
                    'got': response.status_code,
                    'response': response.text[:200]
                })
                print(f"❌ FAIL - Expected {expected_status}, got {response.status_code}")
                print(f"   Response: {response.text[:200]}...")
                return False, {}

        except requests.exceptions.RequestException as e:
            self.failed_tests.append({
                'test': name, 
                'error': str(e)
            })
            print(f"❌ FAIL - Network Error: {str(e)}")
            return False, {}

    def test_health(self):
        """Test health endpoint"""
        success, response = self.run_test(
            "Health Check", 
            "GET", 
            "/api/health"
        )
        if success and isinstance(response, dict):
            assert response.get('status') == 'ok', "Health status not 'ok'"
            assert 'service' in response, "Service name missing from health"
        return success

    def test_stats(self):
        """Test stats endpoint"""
        success, response = self.run_test(
            "Get Stats", 
            "GET", 
            "/api/stats"
        )
        if success and isinstance(response, dict):
            required_fields = ['total_trades', 'win_rate', 'total_profit_eth', 'total_profit_usd']
            for field in required_fields:
                assert field in response, f"Missing required field: {field}"
        return success

    def test_opportunities(self):
        """Test opportunities endpoint"""
        success, response = self.run_test(
            "Get Opportunities", 
            "GET", 
            "/api/opportunities"
        )
        if success and isinstance(response, dict):
            assert 'opportunities' in response, "Missing 'opportunities' key"
            assert 'count' in response, "Missing 'count' key"
            assert isinstance(response['opportunities'], list), "'opportunities' should be a list"
        return success

    def test_trades(self):
        """Test trades endpoint"""
        success, response = self.run_test(
            "Get Trades", 
            "GET", 
            "/api/trades"
        )
        if success and isinstance(response, dict):
            assert 'trades' in response, "Missing 'trades' key"
            assert 'count' in response, "Missing 'count' key"
            assert isinstance(response['trades'], list), "'trades' should be a list"
        return success

    def test_logs(self):
        """Test logs endpoint"""
        success, response = self.run_test(
            "Get Logs", 
            "GET", 
            "/api/logs"
        )
        if success and isinstance(response, dict):
            assert 'logs' in response, "Missing 'logs' key"
            assert 'count' in response, "Missing 'count' key"
            assert isinstance(response['logs'], list), "'logs' should be a list"
        return success

    def test_status(self):
        """Test bot status endpoint"""
        success, response = self.run_test(
            "Get Bot Status", 
            "GET", 
            "/api/status"
        )
        if success and isinstance(response, dict):
            assert 'network' in response, "Missing 'network' field in status"
            assert response.get('network') == 'base', "Network should be 'base'"
        return success

    def test_settings_get(self):
        """Test get settings endpoint"""
        success, response = self.run_test(
            "Get Settings", 
            "GET", 
            "/api/settings"
        )
        if success and isinstance(response, dict):
            required_fields = ['max_gas_price_gwei', 'min_profit_threshold']
            for field in required_fields:
                assert field in response, f"Missing required field: {field}"
        return success, response

    def test_settings_update(self):
        """Test update settings endpoint"""
        # Get current settings first
        get_success, current_settings = self.test_settings_get()
        if not get_success:
            return False
        
        # Update with modified values
        update_data = {
            "max_gas_price_gwei": 0.2,
            "min_profit_threshold": 0.002
        }
        
        success, response = self.run_test(
            "Update Settings", 
            "PUT", 
            "/api/settings",
            data=update_data
        )
        if success and isinstance(response, dict):
            assert response.get('max_gas_price_gwei') == 0.2, "Settings not updated"
            assert response.get('min_profit_threshold') == 0.002, "Settings not updated"
        return success

    def test_opportunities_with_limit(self):
        """Test opportunities endpoint with limit parameter"""
        success, response = self.run_test(
            "Get Opportunities with Limit", 
            "GET", 
            "/api/opportunities?limit=10"
        )
        if success and isinstance(response, dict):
            assert len(response['opportunities']) <= 10, "Limit parameter not working"
        return success

    def test_logs_with_level_filter(self):
        """Test logs endpoint with level filter"""
        success, response = self.run_test(
            "Get Logs with Level Filter", 
            "GET", 
            "/api/logs?level=INFO&limit=20"
        )
        if success and isinstance(response, dict):
            for log in response.get('logs', []):
                assert log.get('level') == 'INFO', "Level filter not working"
        return success

    def run_all_tests(self):
        """Run all API tests"""
        print("="*60)
        print("FlashBot Dashboard API Test Suite")
        print("="*60)
        print(f"Testing API at: {self.base_url}")
        print(f"Started at: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        
        test_methods = [
            self.test_health,
            self.test_stats,
            self.test_opportunities,
            self.test_trades,
            self.test_logs,
            self.test_status,
            self.test_settings_get,
            self.test_settings_update,
            self.test_opportunities_with_limit,
            self.test_logs_with_level_filter,
        ]
        
        for test_method in test_methods:
            try:
                test_method()
            except AssertionError as e:
                print(f"❌ ASSERTION FAILED: {e}")
                self.failed_tests.append({
                    'test': test_method.__name__,
                    'assertion_error': str(e)
                })
            except Exception as e:
                print(f"❌ UNEXPECTED ERROR: {e}")
                self.failed_tests.append({
                    'test': test_method.__name__,
                    'unexpected_error': str(e)
                })

        # Print summary
        print("\n" + "="*60)
        print("TEST SUMMARY")
        print("="*60)
        print(f"Total tests: {self.tests_run}")
        print(f"Passed: {self.tests_passed}")
        print(f"Failed: {self.tests_run - self.tests_passed}")
        print(f"Success rate: {(self.tests_passed/self.tests_run*100):.1f}%")
        
        if self.failed_tests:
            print("\nFAILED TESTS:")
            for failure in self.failed_tests:
                print(f"- {failure}")
        
        return self.tests_passed == self.tests_run

def main():
    """Main test runner"""
    tester = FlashBotAPITester()
    success = tester.run_all_tests()
    return 0 if success else 1

if __name__ == "__main__":
    sys.exit(main())