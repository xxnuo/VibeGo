package blockterm

import (
	"os"
	"path/filepath"
	"strings"
)

func shellSetup(shell, directory, nonce string) ([]string, []string, error) {
	env := append(os.Environ(), "TERM=xterm-256color", "VIBEGO_BLOCK_NONCE="+nonce, "VIBEGO_BLOCK_INPUT="+filepath.Join(directory, "input"))
	name := strings.TrimSuffix(strings.ToLower(filepath.Base(shell)), ".exe")
	var script string
	var args []string
	path := filepath.Join(directory, "integration")
	switch name {
	case "bash":
		script = bashIntegration
		args = []string{"--rcfile", path, "-i"}
	case "zsh":
		path = filepath.Join(directory, ".zshrc")
		script = zshIntegration
		original := os.Getenv("ZDOTDIR")
		if original == "" {
			original, _ = os.UserHomeDir()
		}
		env = append(env, "VIBEGO_ORIGINAL_ZDOTDIR="+original, "VIBEGO_INTEGRATION_ZDOTDIR="+directory, "ZDOTDIR="+directory)
		if err := os.WriteFile(filepath.Join(directory, ".zshenv"), []byte("[[ -f \"$VIBEGO_ORIGINAL_ZDOTDIR/.zshenv\" ]] && source \"$VIBEGO_ORIGINAL_ZDOTDIR/.zshenv\"\nZDOTDIR=$VIBEGO_INTEGRATION_ZDOTDIR\n"), 0600); err != nil {
			return nil, nil, err
		}
		args = []string{"-i"}
	case "fish":
		script = fishIntegration
		args = []string{"-i", "-C", "source '" + strings.ReplaceAll(path, "'", "\\'") + "'"}
	case "pwsh", "powershell":
		path += ".ps1"
		script = powershellIntegration
		args = []string{"-NoLogo", "-NoExit", "-ExecutionPolicy", "RemoteSigned", "-File", path}
	default:
		return nil, env, nil
	}
	if err := os.WriteFile(path, []byte(script), 0600); err != nil {
		return nil, nil, err
	}
	return args, env, nil
}

const bashIntegration = `
[[ -f ~/.bashrc ]] && source ~/.bashrc
__vg_previous_prompt=("${PROMPT_COMMAND[@]}")
__vg_previous_debug=$(builtin trap -p DEBUG)
__vg_previous_debug=${__vg_previous_debug#trap -- }
__vg_previous_debug=${__vg_previous_debug% DEBUG}
builtin eval "__vg_previous_debug=$__vg_previous_debug"
__vg_running=0
__vg_counter=0
__vg_use_ps0=0
__vg_accepting=0
__vg_command=''
__vg_ps0_started=0
__vg_prompt() {
    local result=$?
    __vg_running=1
    local previous
    for previous in "${__vg_previous_prompt[@]}"; do
        [[ -n $previous && $previous != __vg_prompt ]] && builtin eval "$previous"
    done
    __vg_running=0
    printf '\033]777;vibego;%s;end;%s;%s;;;%s\007' "$VIBEGO_BLOCK_NONCE" "$result" "$(printf '%s' "$PWD" | base64 | tr -d '\r\n')" "$__vg_counter"
    PS1='' PS2='> '
    __vg_accepting=0
    __vg_command=''
    __vg_ps0_started=0
    return "$result"
}
__vg_start() {
    [[ $__vg_use_ps0 == 1 ]] && return
    if [[ $__vg_running == 0 && $BASH_COMMAND != __vg_* ]]; then
        __vg_running=1
        __vg_counter=$((__vg_counter+1))
        printf '\033]777;vibego;%s;start;%s;%s\007' "$VIBEGO_BLOCK_NONCE" "$(printf '%s' "$BASH_COMMAND" | base64 | tr -d '\r\n')" "$__vg_counter"
    fi
}
__vg_replace() {
    [[ -f $VIBEGO_BLOCK_INPUT ]] || return
    IFS= read -r -d '' READLINE_LINE < "$VIBEGO_BLOCK_INPUT" || :
    local LC_ALL=C
    READLINE_POINT=${#READLINE_LINE}
}
bind -x '"\e[23~":__vg_replace'
bind '"\e[24~":"\e[23~\C-m"'
if (( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4) )); then
    __vg_use_ps0=1
    printf '\033]777;vibego;%s;capabilities;accept\007' "$VIBEGO_BLOCK_NONCE"
    __vg_capture() {
        if [[ $__vg_accepting == 1 ]]; then
            __vg_command+=$'\n'"$READLINE_LINE"
        else
            [[ -n $READLINE_LINE ]] || return
            __vg_command=$READLINE_LINE
            __vg_counter=$((__vg_counter+1))
        fi
        __vg_accepting=1
        printf '\033]777;vibego;%s;accept;%s;%s\007' "$VIBEGO_BLOCK_NONCE" "$(printf '%s' "$__vg_command" | base64 | tr -d '\r\n')" "$__vg_counter"
    }
    bind -x '"\e[25~":__vg_capture'
    bind '"\e[26~":accept-line'
    bind '"\C-m":"\e[25~\e[26~"'
    bind '"\C-j":"\e[25~\e[26~"'
    PS0='\e]777;vibego;${VIBEGO_BLOCK_NONCE};start;$(printf "%s" "$__vg_command" | base64 | tr -d "\r\n");$((__vg_counter+=!__vg_accepting*!__vg_ps0_started,__vg_ps0_started=1,__vg_counter))\a'
fi
PROMPT_COMMAND=__vg_prompt
builtin trap "__vg_start; $__vg_previous_debug" DEBUG
`

const zshIntegration = `
[[ -f "$VIBEGO_ORIGINAL_ZDOTDIR/.zshrc" ]] && source "$VIBEGO_ORIGINAL_ZDOTDIR/.zshrc"
ZDOTDIR=$VIBEGO_ORIGINAL_ZDOTDIR
__vg_counter=0
__vg_accepting=0
__vg_preexec() { (( __vg_accepting )) || (( __vg_counter++ )); printf '\033]777;vibego;%s;start;%s;%s\007' "$VIBEGO_BLOCK_NONCE" "$(printf '%s' "$1" | base64 | tr -d '\r\n')" "$__vg_counter"; }
__vg_precmd() {
    local result=$?
    printf '\033]777;vibego;%s;end;%s;%s;;;%s\007' "$VIBEGO_BLOCK_NONCE" "$result" "$(printf '%s' "$PWD" | base64 | tr -d '\r\n')" "$__vg_counter"
    __vg_accepting=0
    PROMPT='' RPROMPT=''
}
__vg_accept_line() {
    if [[ -n $BUFFER ]]; then
        (( __vg_accepting )) || (( __vg_counter++ ))
        __vg_accepting=1
        printf '\033]777;vibego;%s;accept;%s;%s\007' "$VIBEGO_BLOCK_NONCE" "$(printf '%s' "$BUFFER" | base64 | tr -d '\r\n')" "$__vg_counter"
    fi
    zle __vg_previous_accept_line
}
zle -A accept-line __vg_previous_accept_line
zle -N accept-line __vg_accept_line
__vg_replace() {
    [[ -f $VIBEGO_BLOCK_INPUT ]] || return
    BUFFER=$(<"$VIBEGO_BLOCK_INPUT")
    CURSOR=${#BUFFER}
}
__vg_accept() { __vg_replace; zle accept-line; }
zle -N __vg_replace
zle -N __vg_accept
bindkey '\e[23~' __vg_replace
bindkey '\e[24~' __vg_accept
preexec_functions=(${preexec_functions:#__vg_preexec} __vg_preexec)
precmd_functions=(__vg_precmd ${precmd_functions:#__vg_precmd})
printf '\033]777;vibego;%s;capabilities;accept\007' "$VIBEGO_BLOCK_NONCE"
`

const fishIntegration = `
set -g __vg_counter 0
set -g __vg_accepting 0
functions -q fish_prompt; and functions -c fish_prompt __vg_previous_prompt
function __vg_preexec --on-event fish_preexec
    if not string match -rq '\S' -- "$argv[1]"
        return
    end
    if test $__vg_accepting -eq 0
        set -g __vg_counter (math $__vg_counter + 1)
    end
    printf '\033]777;vibego;%s;start;%s;%s\007' "$VIBEGO_BLOCK_NONCE" (printf '%s' "$argv[1]" | base64 | string join '') "$__vg_counter"
end
function fish_prompt
    set -l result $status
    functions -q __vg_previous_prompt; and __vg_previous_prompt >/dev/null
    printf '\033]777;vibego;%s;end;%s;%s;;;%s\007' "$VIBEGO_BLOCK_NONCE" "$result" (printf '%s' "$PWD" | base64 | string join '') "$__vg_counter"
    set -g __vg_accepting 0
end
function __vg_posterror --on-event fish_posterror
    printf '\033]777;vibego;%s;end;1;%s;;;%s\007' "$VIBEGO_BLOCK_NONCE" (printf '%s' "$PWD" | base64 | string join '') "$__vg_counter"
    set -g __vg_accepting 0
end
function __vg_cancel --on-event fish_cancel
    printf '\033]777;vibego;%s;end;130;%s;;;%s\007' "$VIBEGO_BLOCK_NONCE" (printf '%s' "$PWD" | base64 | string join '') "$__vg_counter"
    set -g __vg_accepting 0
end
function __vg_execute
    set -l value (commandline --current-buffer | string collect --no-trim-newlines)
    if test -n "$value"
        if test $__vg_accepting -eq 0
            set -g __vg_counter (math $__vg_counter + 1)
        end
        set -g __vg_accepting 1
        printf '\033]777;vibego;%s;accept;%s;%s\007' "$VIBEGO_BLOCK_NONCE" (printf '%s' "$value" | base64 | string join '') "$__vg_counter"
    end
    commandline -f execute
end
function fish_right_prompt
end
function __vg_replace
    test -f "$VIBEGO_BLOCK_INPUT"; or return
    set -l value (string collect --no-trim-newlines < "$VIBEGO_BLOCK_INPUT")
    commandline -r -- "$value"
end
function __vg_accept
    __vg_replace
    __vg_execute
end
bind \r __vg_execute
bind \n __vg_execute
bind \e\[23~ __vg_replace
bind \e\[24~ __vg_accept
printf '\033]777;vibego;%s;capabilities;accept\007' "$VIBEGO_BLOCK_NONCE"
`

const powershellIntegration = `
$global:__VgCounter = 0
$global:__VgAccepted = $false
$global:__VgParseFailed = $false
$global:__VgPreviousPrompt = ${function:prompt}
function global:__VgHook([string]$value) {
    [Console]::Write("$([char]27)]777;vibego;$env:VIBEGO_BLOCK_NONCE;$value$([char]7)")
}
function global:prompt {
    $ok = $?
    $native = $global:LASTEXITCODE
    if ($global:__VgParseFailed) { $ok = $false }
    $global:__VgParseFailed = $false
    if ($global:__VgPreviousPrompt) { $null = & $global:__VgPreviousPrompt }
    $result = if ($ok) { 0 } else { 1 }
    $cwd = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($PWD.Path))
    __VgHook "end;$result;$cwd;$ok;$native;$global:__VgCounter"
    $global:__VgAccepted = $false
    return ' '
}
Import-Module PSReadLine -ErrorAction SilentlyContinue
if (Get-Command PSConsoleHostReadLine -ErrorAction SilentlyContinue) {
    function global:__VgAcceptInput {
        $value = ''; $cursor = 0
        [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$value, [ref]$cursor)
        if ($value) {
            if (!$global:__VgAccepted) { $global:__VgCounter++ }
            $global:__VgAccepted = $true
            $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($value))
            __VgHook "accept;$encoded;$global:__VgCounter"
        }
        [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
    }
    Set-PSReadLineKeyHandler -Key Enter -ScriptBlock { __VgAcceptInput }
    Set-PSReadLineKeyHandler -Key Ctrl+c -ScriptBlock {
        [Microsoft.PowerShell.PSConsoleReadLine]::CancelLine()
        $cwd = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($PWD.Path))
        __VgHook "end;130;$cwd;;;$global:__VgCounter"
        $global:__VgAccepted = $false
    }
    Set-PSReadLineKeyHandler -Key F12 -ScriptBlock {
        if ([IO.File]::Exists($env:VIBEGO_BLOCK_INPUT)) {
            $value = [IO.File]::ReadAllText($env:VIBEGO_BLOCK_INPUT)
            [Microsoft.PowerShell.PSConsoleReadLine]::RevertLine()
            [Microsoft.PowerShell.PSConsoleReadLine]::Insert($value)
            __VgAcceptInput
        }
    }
    Set-PSReadLineKeyHandler -Key F11 -ScriptBlock {
        if ([IO.File]::Exists($env:VIBEGO_BLOCK_INPUT)) {
            $value = [IO.File]::ReadAllText($env:VIBEGO_BLOCK_INPUT)
            [Microsoft.PowerShell.PSConsoleReadLine]::RevertLine()
            [Microsoft.PowerShell.PSConsoleReadLine]::Insert($value)
        }
    }
    $global:__VgReadLine = ${function:PSConsoleHostReadLine}
    function global:PSConsoleHostReadLine {
        $line = & $global:__VgReadLine
        if ($line -and $line.Trim().Length -gt 0) {
            $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($line))
            if (!$global:__VgAccepted) {
                $global:__VgCounter++
                __VgHook "accept;$encoded;$global:__VgCounter"
                $global:__VgAccepted = $true
            }
            $tokens = $null; $parseErrors = $null
            $null = [System.Management.Automation.Language.Parser]::ParseInput($line, [ref]$tokens, [ref]$parseErrors)
            $global:__VgParseFailed = $parseErrors.Count -gt 0
            if (!$parseErrors.Count) { __VgHook "start;$encoded;$global:__VgCounter" }
        }
        return $line
    }
    __VgHook 'capabilities;accept'
}
`
