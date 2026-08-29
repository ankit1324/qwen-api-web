cat /Users/ankit/Developer/myProject/qwen-api-web/.superpowers/sdd/review-0c027fd..7d7e071.diff | awk '
/^diff --git a\/config.example.json b\/config.example.json/ { print_flag = 1 }
/^diff --git a\/package-lock.json b\/package-lock.json/ { print_flag = 0 }
/^diff --git a\/package.json b\/package.json/ { print_flag = 1 }
print_flag == 1 { print }
'
