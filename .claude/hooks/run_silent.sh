#!/bin/bash
# Context-efficient command execution for Claude Code hooks
# Based on https://github.com/humanlayer/humanlayer/blob/main/hack/run_silent.sh
#
# Philosophy: Stay in the "~75k token smart zone"
# - Success = checkmark with summary
# - Failure = full output for debugging
#
# See: https://www.hlyr.dev/blog/context-efficient-backpressure

set -e

# Color codes
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Check if verbose mode is enabled (for debugging)
VERBOSE=${VERBOSE:-0}

# Run command silently, show output only on failure
run_silent() {
    local description="$1"
    local command="$2"

    if [ "$VERBOSE" = "1" ]; then
        echo "  → Running: $command"
        # Guard against errexit: capture exit code instead of aborting
        if eval "$command"; then
            return 0
        else
            return $?
        fi
    fi

    local tmp_file=$(mktemp)
    if eval "$command" > "$tmp_file" 2>&1; then
        printf "  ${GREEN}✓${NC} %s\n" "$description"
        rm -f "$tmp_file"
        return 0
    else
        local exit_code=$?
        printf "  ${RED}✗${NC} %s\n" "$description"
        printf "${RED}Command failed: %s${NC}\n" "$command"
        cat "$tmp_file"
        rm -f "$tmp_file"
        return $exit_code
    fi
}

# Run a test command and, for recognized runners, extract a test count.
# Pass the runner as the 3rd arg to get a richer summary line; known values are
# "pytest", "vitest", and "mill". Anything else (or omitted) just prints success.
run_silent_with_test_count() {
    local description="$1"
    local command="$2"
    local test_type="${3:-generic}"

    if [ "$VERBOSE" = "1" ]; then
        echo "  → Running: $command"
        # Guard against errexit: capture exit code instead of aborting
        if eval "$command"; then
            return 0
        else
            return $?
        fi
    fi

    local tmp_file=$(mktemp)
    local test_count=""

    if eval "$command" > "$tmp_file" 2>&1; then
        case "$test_type" in
            pytest)
                # Look for pytest summary line like "45 passed in 2.3s"
                test_count=$(grep -E "[0-9]+ passed" "$tmp_file" | grep -oE "^[0-9]+ passed" | awk '{print $1}' | tail -1)
                if [ -n "$test_count" ]; then
                    local duration=$(grep -E "[0-9]+ passed" "$tmp_file" | grep -oE "in [0-9.]+s" | tail -1)
                    printf "  ${GREEN}✓${NC} %s (%s tests%s)\n" "$description" "$test_count" "${duration:+, $duration}"
                else
                    printf "  ${GREEN}✓${NC} %s\n" "$description"
                fi
                ;;
            vitest)
                # Look for vitest summary
                test_count=$(grep -E "Test Files.*passed" "$tmp_file" | grep -oE "[0-9]+ passed" | awk '{print $1}' | head -1)
                if [ -n "$test_count" ]; then
                    printf "  ${GREEN}✓${NC} %s (%s test files)\n" "$description" "$test_count"
                else
                    printf "  ${GREEN}✓${NC} %s\n" "$description"
                fi
                ;;
            mill)
                # For Scala mill tests - just show success
                printf "  ${GREEN}✓${NC} %s\n" "$description"
                ;;
            *)
                printf "  ${GREEN}✓${NC} %s\n" "$description"
                ;;
        esac
        rm -f "$tmp_file"
        return 0
    else
        local exit_code=$?
        printf "  ${RED}✗${NC} %s\n" "$description"

        # For test failures, show only the failure summary, not all passed tests
        case "$test_type" in
            pytest)
                # Show short summary + failures only (pytest's -x flag helps here)
                # Extract FAILURES section and short test summary
                if grep -q "FAILED\|ERROR\|short test summary" "$tmp_file"; then
                    printf "${RED}Test failures:${NC}\n"
                    # Get from "short test summary" or "FAILURES" to end
                    # Use -E for extended regex (macOS/BSD sed requires -E for alternation)
                    sed -n -E '/short test summary|FAILURES|ERRORS/,$p' "$tmp_file"
                else
                    # Fallback: show full output if no failures section found
                    cat "$tmp_file"
                fi
                ;;
            vitest)
                # Show vitest failures
                if grep -q "FAIL\|Error:" "$tmp_file"; then
                    printf "${RED}Test failures:${NC}\n"
                    grep -A 20 "FAIL\|Error:" "$tmp_file" | head -50
                else
                    cat "$tmp_file"
                fi
                ;;
            *)
                cat "$tmp_file"
                ;;
        esac
        rm -f "$tmp_file"
        return $exit_code
    fi
}

# Run lint command with condensed output
run_silent_lint() {
    local description="$1"
    local command="$2"

    if [ "$VERBOSE" = "1" ]; then
        echo "  → Running: $command"
        # Guard against errexit: capture exit code instead of aborting
        if eval "$command"; then
            return 0
        else
            return $?
        fi
    fi

    local tmp_file=$(mktemp)
    if eval "$command" > "$tmp_file" 2>&1; then
        printf "  ${GREEN}✓${NC} %s\n" "$description"
        rm -f "$tmp_file"
        return 0
    else
        local exit_code=$?
        printf "  ${RED}✗${NC} %s\n" "$description"

        # For lint failures, show only the errors, not the full file list
        local error_count=$(wc -l < "$tmp_file" | tr -d ' ')
        if [ "$error_count" -gt 50 ]; then
            printf "${RED}Found %s issues (showing first 30):${NC}\n" "$error_count"
            head -30 "$tmp_file"
            printf "${YELLOW}... and %s more${NC}\n" "$((error_count - 30))"
        else
            cat "$tmp_file"
        fi
        rm -f "$tmp_file"
        return $exit_code
    fi
}

# Print section header
print_header() {
    local title="$1"
    printf "\n${BLUE}━━━ %s ━━━${NC}\n" "$title"
}

# Export functions for use in other scripts
export -f run_silent
export -f run_silent_with_test_count
export -f run_silent_lint
export -f print_header
