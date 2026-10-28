Output docs/assets/demo.gif
Set Shell "bash"
Set FontSize 15
Set Width 1280
Set Height 760
Set Padding 18
Set TypingSpeed 35ms
Set Theme "GitHub Dark"

Hide
Type `cd e2e/.output/demo && source demo-env.sh && clear`
Enter
Sleep 1s
Show

Type "# record a login on the fixture shop (scripted here; normally you just browse)"
Enter
Type "site-to-api capture http://localhost:4173 --headless --channel bundled --session login --script ../../scenarios/login.ts | tail -2"
Enter
Sleep 22s
Type "site-to-api build | tail -2"
Enter
Sleep 12s
Type "clear && sed -n '/## Session requirements/,/^- Spec/p' api-handoff/AGENT.md"
Enter
Sleep 6s
Type "clear && sed -n '/## Values computed/,/^## Gaps/p' api-handoff/AGENT.md | fold -s -w 120"
Enter
Sleep 6s
Type "ls api-handoff api-handoff/client"
Enter
Sleep 5s
